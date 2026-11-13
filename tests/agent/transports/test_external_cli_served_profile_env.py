"""The external CLIs that drive a model for a turn (``codex app-server``, an ACP agent) start
from the env of the profile the turn serves.

One process serves several profiles and ``os.environ`` holds the LAUNCH profile's ``.env``. A turn
for profile B that spawns its CLI must hand it B's provider credentials and none of the launch
profile's, and must keep withholding Tier-1 secrets (bot tokens, the vault bootstrap token) that no
model-driven executor has a use for, whichever profile owns them.
"""

import json
import subprocess
import sys

import pytest

from agent.secret_scope import set_multiplex_active

_NAMES = ("HERMES_HOME", "OPENAI_API_KEY", "A_MARKER", "HERMES_MODEL", "TELEGRAM_BOT_TOKEN",
          "OP_SERVICE_ACCOUNT_TOKEN")
_PROBE = f"import json,os;print(json.dumps({{k:os.environ.get(k) for k in {_NAMES!r}}}))"


@pytest.fixture
def homes(tmp_path, monkeypatch):
    """Launch home A (its .env mirrored into os.environ, as the process loads it) and served home B."""
    a = tmp_path / ".hermes"
    b = a / "profiles" / "b"
    b.mkdir(parents=True)
    launch = {"OPENAI_API_KEY": "a-key", "A_MARKER": "a", "HERMES_MODEL": "a-model",
              "TELEGRAM_BOT_TOKEN": "a-bot", "OP_SERVICE_ACCOUNT_TOKEN": "a-vault"}
    (a / ".env").write_text("".join(f"{k}={v}\n" for k, v in launch.items()), encoding="utf-8")
    (b / ".env").write_text("OPENAI_API_KEY=b-key\nTELEGRAM_BOT_TOKEN=b-bot\n", encoding="utf-8")
    monkeypatch.setenv("HERMES_HOME", str(a))
    for key, val in launch.items():
        monkeypatch.setenv(key, val)
    yield a, b
    set_multiplex_active(False)


def _codex_spawn_env(monkeypatch) -> dict:
    from agent.transports import codex_app_server

    captured = {}

    class _Popen:
        stdin = None
        stdout = stderr = ()

        def __init__(self, argv, **kw):
            captured["env"] = kw["env"]

    with monkeypatch.context() as m:
        m.setattr(codex_app_server.subprocess, "Popen", _Popen)
        codex_app_server.CodexAppServerClient()
    return captured["env"]


def _acp_spawn_env(_monkeypatch) -> dict:
    from agent.acp_client import _build_subprocess_env
    return _build_subprocess_env()


def _child_view(env: dict) -> dict:
    out = subprocess.run([sys.executable, "-c", _PROBE], env=env, capture_output=True, text=True,
                         encoding="utf-8", timeout=60, check=False)
    return json.loads(out.stdout.strip().splitlines()[-1])


_SPAWNS = [pytest.param(_codex_spawn_env, id="codex-app-server"), pytest.param(_acp_spawn_env, id="acp")]


@pytest.mark.parametrize("spawn_env", _SPAWNS)
def test_cli_spawned_for_a_served_profile_gets_that_profiles_env(homes, monkeypatch, spawn_env):
    from gateway.run import _profile_runtime_scope

    _a, b = homes
    set_multiplex_active(True)
    with _profile_runtime_scope(b, hydrate_secrets=False):
        env = spawn_env(monkeypatch)
    assert _child_view(env) == {
        "HERMES_HOME": str(b), "OPENAI_API_KEY": "b-key", "A_MARKER": None, "HERMES_MODEL": None,
        "TELEGRAM_BOT_TOKEN": None, "OP_SERVICE_ACCOUNT_TOKEN": None}


@pytest.mark.parametrize("spawn_env", _SPAWNS)
def test_cli_spawned_for_the_launch_profile_keeps_its_env_without_tier1_secrets(homes, monkeypatch, spawn_env):
    a, _b = homes
    assert _child_view(spawn_env(monkeypatch)) == {
        "HERMES_HOME": str(a), "OPENAI_API_KEY": "a-key", "A_MARKER": "a", "HERMES_MODEL": "a-model",
        "TELEGRAM_BOT_TOKEN": None, "OP_SERVICE_ACCOUNT_TOKEN": None}
