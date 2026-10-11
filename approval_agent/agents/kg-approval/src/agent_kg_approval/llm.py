"""LLM provider selection for KG Approval."""

from __future__ import annotations

import os

from langchain_core.language_models import BaseChatModel

def build_llm(temperature: float = 0) -> BaseChatModel:
    raise NotImplementedError("Implement your LLM client here, read credentials from environment variables, and return a BaseChatModel.")
