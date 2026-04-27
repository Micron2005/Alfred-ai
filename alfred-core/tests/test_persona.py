"""Persona construction tests — make sure both modes produce sane prompts."""

from __future__ import annotations

from datetime import datetime
from zoneinfo import ZoneInfo

from alfred_core.config import Settings
from alfred_core.persona import ContextBundle, Mode, build_persona


def _settings() -> Settings:
    return Settings(
        alfred_user_full_name="Mukarram Mohammad Alam",
        alfred_user_short_name="Mukarram",
        alfred_user_address="sir",
        alfred_user_address_nightfall="Batman",
    )


def test_standard_persona_addresses_user_correctly() -> None:
    persona = build_persona(Mode.STANDARD, _settings())
    assert persona.mode is Mode.STANDARD
    assert "Mukarram Mohammad Alam" in persona.system_prompt
    assert '"sir"' in persona.system_prompt
    assert "Mukarram" in persona.system_prompt
    assert "sir" in persona.greeting.lower()


def test_persona_includes_search_prompt_only_when_tavily_configured() -> None:
    """SEARCH tool instructions should only ship when an API key is set."""
    persona_off = build_persona(
        Mode.STANDARD, Settings(alfred_tavily_api_key="")
    )
    assert "WEB SEARCH" not in persona_off.system_prompt
    assert "[SEARCH:" not in persona_off.system_prompt

    persona_on = build_persona(
        Mode.STANDARD, Settings(alfred_tavily_api_key="key")
    )
    assert "WEB SEARCH" in persona_on.system_prompt
    assert "[SEARCH:" in persona_on.system_prompt
    # Nightfall should also pick it up.
    persona_on_nf = build_persona(
        Mode.NIGHTFALL, Settings(alfred_tavily_api_key="key")
    )
    assert "WEB SEARCH" in persona_on_nf.system_prompt


def test_standard_persona_does_not_assume_bruce_wayne() -> None:
    persona = build_persona(Mode.STANDARD, _settings())
    # The prompt must explicitly correct the Bruce Wayne assumption.
    assert "NOT Bruce Wayne" in persona.system_prompt
    assert "real human being" in persona.system_prompt


def test_nightfall_persona_uses_batman() -> None:
    persona = build_persona(Mode.NIGHTFALL, _settings())
    assert persona.mode is Mode.NIGHTFALL
    assert "Mukarram Mohammad Alam" in persona.system_prompt
    assert '"sir"' in persona.system_prompt
    assert '"Batman"' in persona.system_prompt
    assert "Batman" in persona.greeting


def test_nightfall_persona_keeps_callsign_when_others_present() -> None:
    """The rule 'don't drop Batman just because others are around' must be explicit."""
    persona = build_persona(Mode.NIGHTFALL, _settings())
    prompt = persona.system_prompt
    assert "do NOT drop" in prompt
    assert "callsign" in prompt.lower()
    assert "others" in prompt.lower()


def test_persona_includes_remember_instruction() -> None:
    persona = build_persona(Mode.STANDARD, _settings())
    assert "[REMEMBER:" in persona.system_prompt


def test_standard_and_nightfall_differ() -> None:
    settings = _settings()
    std = build_persona(Mode.STANDARD, settings)
    night = build_persona(Mode.NIGHTFALL, settings)
    assert std.system_prompt != night.system_prompt


def test_persona_injects_time_and_facts() -> None:
    now = datetime(2026, 4, 24, 14, 30, tzinfo=ZoneInfo("America/New_York"))
    context = ContextBundle(
        now_local=now,
        timezone_label="America/New_York",
        weather_summary="72°F, partly cloudy, wind 5 mph (in Fredericksburg, VA)",
        known_facts=(
            "His sister's name is Amira.",
            "He strongly dislikes cilantro.",
        ),
    )
    persona = build_persona(Mode.STANDARD, _settings(), context)
    assert "CURRENT CONTEXT (refreshed each turn)" in persona.system_prompt
    assert "2026" in persona.system_prompt
    assert "Friday" in persona.system_prompt
    assert "America/New_York" in persona.system_prompt
    assert "72°F" in persona.system_prompt
    assert "Amira" in persona.system_prompt
    assert "cilantro" in persona.system_prompt


def test_persona_without_context_omits_block() -> None:
    persona = build_persona(Mode.STANDARD, _settings(), None)
    assert "CURRENT CONTEXT (refreshed each turn)" not in persona.system_prompt


def test_persona_with_empty_context_omits_block() -> None:
    persona = build_persona(Mode.STANDARD, _settings(), ContextBundle())
    assert "CURRENT CONTEXT (refreshed each turn)" not in persona.system_prompt


def test_persona_renders_presence_when_camera_is_on() -> None:
    persona_alone = build_persona(
        Mode.STANDARD, _settings(), ContextBundle(faces_visible=1)
    )
    assert "you can currently see one person" in persona_alone.system_prompt

    persona_company = build_persona(
        Mode.STANDARD, _settings(), ContextBundle(faces_visible=3)
    )
    assert "you can currently see 3 people" in persona_company.system_prompt

    persona_empty = build_persona(
        Mode.STANDARD, _settings(), ContextBundle(faces_visible=0)
    )
    assert "no one" in persona_empty.system_prompt


def test_persona_omits_presence_when_camera_is_off() -> None:
    """When ``faces_visible`` is None, the dynamic presence line must NOT appear."""
    persona = build_persona(Mode.STANDARD, _settings(), ContextBundle())
    # These phrases only appear in the dynamic CURRENT CONTEXT block,
    # not in the static persona body.
    assert "Through the laptop camera you can currently see" not in persona.system_prompt
    assert "presumably him" not in persona.system_prompt
