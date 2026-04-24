"""Persona construction tests — make sure both modes produce sane prompts."""

from __future__ import annotations

from alfred_core.config import Settings
from alfred_core.persona import Mode, build_persona


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


def test_nightfall_persona_uses_batman() -> None:
    persona = build_persona(Mode.NIGHTFALL, _settings())
    assert persona.mode is Mode.NIGHTFALL
    assert "Mukarram Mohammad Alam" in persona.system_prompt
    assert '"sir"' in persona.system_prompt
    assert '"Batman"' in persona.system_prompt
    assert "Batman" in persona.greeting


def test_standard_and_nightfall_differ() -> None:
    settings = _settings()
    std = build_persona(Mode.STANDARD, settings)
    night = build_persona(Mode.NIGHTFALL, settings)
    assert std.system_prompt != night.system_prompt
