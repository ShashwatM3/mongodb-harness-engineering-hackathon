"""Raindrop routing: fake-runner and demo events never reach the real project's cohorts."""
from kg.config import Config
from kg.raindrop_sink import NullSink, sink_from_config


def cfg(**kw):
    base = dict(raindrop_write_key="k", raindrop_project_id="kg-real", raindrop_dev_project_id="kg-dev",
                raindrop_dev=None, runner_url=None)
    return Config(**{**base, **kw})


def test_fake_runner_goes_to_dev_project():
    assert cfg().raindrop_target() == (True, "kg-dev")


def test_real_runner_goes_to_real_project():
    assert cfg(runner_url="http://localhost:8787").raindrop_target() == (False, "kg-real")


def test_override_and_explicit_dev():
    assert cfg(raindrop_dev=False).raindrop_target() == (False, "kg-real")
    assert cfg(runner_url="http://x", raindrop_dev=True).raindrop_target() == (True, "kg-dev")
    assert cfg(runner_url="http://x").raindrop_target(dev=True) == (True, "kg-dev")


def test_dev_run_without_dev_project_sends_nothing():
    assert isinstance(sink_from_config(cfg(raindrop_dev_project_id=None)), NullSink)
    assert isinstance(sink_from_config(cfg(raindrop_enabled=False)), NullSink)
