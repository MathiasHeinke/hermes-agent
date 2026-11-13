"""A steer accepted while a turn winds down becomes the next turn, never the buffer of an idle agent.

The agent reads its steer buffer for the last time in the turn finalizer. The session still counts
as running after that (``message.complete``, the goal judge, post-turn hooks), and a mid-turn
message is steered all that time: ``session.steer`` answers ``queued``, ``prompt.submit`` in the
``steer`` busy mode answers ``steered``. Nothing read that text: it waited on the idle agent until
some later turn found it (#66704, #141973).

The tests run the real ``prompt.submit`` and ``session.steer`` handlers against an agent with the
real steer buffer (``InterruptControlMixin``) and a scripted ``run_conversation``.
"""

from __future__ import annotations

import threading
from unittest.mock import MagicMock

import pytest

from agent.interrupt_control import InterruptControlMixin
from tui_gateway import server

ASK = "find three bakeries in Porto"
LATE = "use Lisbon instead of Porto"


class _ImmediateThread:
    def __init__(self, target=None, daemon=None, **kw):
        self._target = target

    def start(self):
        self._target()


class _Agent(InterruptControlMixin):
    """The real steer buffer under a scripted turn."""

    session_id = "k"
    _cached_system_prompt = ""

    def __init__(self, script):
        self._pending_steer = None
        self._pending_steer_lock = threading.Lock()
        self._script, self.asked = script, []

    def run_conversation(self, prompt, **kwargs):
        self.asked.append(prompt)
        return self._script(self)


def _rpc(method, text):
    return server.handle_request({"id": method, "method": method, "params": {"session_id": "sid", "text": text}})


def _reply(agent, **extra):
    return {"final_response": "Done.", "completed": True,
            "messages": [{"role": "assistant", "content": "Done."}], **extra}


@pytest.fixture
def live(monkeypatch):
    """Runs one prompt to its end; ``live.winding_down`` hooks fire once, between the turn's
    ``message.complete`` and its release of ``running``."""
    hooks, completions = [], []

    def emit(event, *args, **kwargs):
        if event == "message.complete":
            completions.append(args)
            for hook in hooks[:]:
                hooks.remove(hook)
                hook()

    monkeypatch.setattr(server, "_emit", emit)
    monkeypatch.setattr(server, "_get_db", lambda: MagicMock())
    monkeypatch.setattr(server, "make_stream_renderer", lambda cols: None)
    monkeypatch.setattr(server, "render_message", lambda raw, cols: None)
    monkeypatch.setattr(server, "_sync_session_key_after_compress", lambda *a, **kw: None)
    monkeypatch.setattr(server.threading, "Thread", _ImmediateThread)
    monkeypatch.setattr(server, "_load_busy_input_mode", lambda: "steer")

    class _Live:
        winding_down, completed = hooks, completions

        def run(self, script=_reply):
            self.agent = _Agent(script)
            self.session = server._sessions["sid"] = {
                "agent": self.agent, "session_key": "k", "history": [], "history_lock": threading.Lock(),
                "history_version": 0, "running": False, "attached_images": [], "image_counter": 0, "cols": 80,
                "slash_worker": None, "show_reasoning": False, "tool_progress_mode": "all", "pending_title": None}
            response = _rpc("prompt.submit", ASK)
            assert "result" in response, response
            return self.agent

    try:
        yield _Live()
    finally:
        server._sessions.pop("sid", None)


@pytest.mark.parametrize("method,accepted", [("session.steer", "queued"), ("prompt.submit", "steered")])
def test_a_steer_accepted_after_the_final_drain_becomes_the_next_turn(live, method, accepted):
    answers = []
    live.winding_down.append(lambda: answers.append(_rpc(method, LATE)))

    agent = live.run()

    assert answers[0]["result"]["status"] == accepted, "the turn still ran: the client was told it is in"
    assert agent.asked == [ASK, LATE], "its own turn, started by the post-turn drain"
    assert agent._pending_steer is None, "nothing is left for some later turn to find"
    assert len(live.completed) == 2 and live.session["running"] is False


def test_a_late_steer_follows_the_leftover_the_finalizer_handed_back(live):
    live.winding_down.append(lambda: _rpc("session.steer", LATE))

    agent = live.run(lambda agent: _reply(agent, **({"pending_steer": "with phone numbers"} if len(agent.asked) == 1 else {})))

    assert len(agent.asked) == 2, "one follow-up turn carries both, each once"
    follow_up = agent.asked[1]
    assert follow_up.count("with phone numbers") == follow_up.count(LATE) == 1
    assert follow_up.index("with phone numbers") < follow_up.index(LATE)


def test_a_steer_accepted_by_a_turn_that_then_failed_is_not_lost(live):
    """The turn raised before any drain: no result carries the steer back, the release still does."""
    answers = []

    def script(agent):
        if len(agent.asked) == 1:
            answers.append(_rpc("session.steer", LATE))
            raise RuntimeError("provider unreachable")
        return _reply(agent)

    agent = live.run(script)

    assert answers[0]["result"]["status"] == "queued"
    assert agent.asked == [ASK, LATE]
    assert agent._pending_steer is None


def test_a_steer_the_turn_read_is_not_run_again(live):
    def script(agent):
        if len(agent.asked) == 1:
            _rpc("session.steer", LATE)
            assert agent._drain_pending_steer() == LATE  # the turn's drain after a tool batch
        return _reply(agent)

    agent = live.run(script)

    assert agent.asked == [ASK]
    assert not live.session.get("queued_prompt")
