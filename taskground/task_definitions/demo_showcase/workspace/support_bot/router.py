"""Keyword router for the support inbox.

Maps a free-text customer request to a (domain, intent) pair, then dispatches
it to the matching handler. Rules are checked in order; the first hit wins.
"""

from support_bot.handlers import account, cards, transfers

KEYWORD_RULES = [
    ("stolen", "cards", "lost_or_stolen_card"),
    ("lost", "cards", "lost_or_stolen_card"),
    ("activate", "cards", "activate_my_card"),
    ("pin", "cards", "pin_blocked"),
    ("arrive", "cards", "card_arrival"),
    ("delivered", "cards", "card_arrival"),
    ("card", "cards", "card_not_working"),
    ("cancel", "transfers", "cancel_transfer"),
    ("failed", "transfers", "failed_transfer"),
    ("pending", "transfers", "pending_transfer"),
    ("how long", "transfers", "transfer_timing"),
    ("password", "account", "passcode_forgotten"),
    ("passcode", "account", "passcode_forgotten"),
    ("close my account", "account", "terminate_account"),
    ("verify", "account", "verify_my_identity"),
]

HANDLERS = {
    **cards.HANDLERS,
    **transfers.HANDLERS,
    **account.HANDLERS,
}


def _normalize(text: str) -> str:
    return " ".join(text.lower().split())


def route(text: str) -> tuple[str, str | None]:
    """Return the (domain, intent) for a request, or ("unrouted", None)."""
    lowered = _normalize(text)
    for keyword, domain, intent in KEYWORD_RULES:
        if keyword in lowered:
            return domain, intent
    return "unrouted", None


def dispatch(text: str) -> str:
    """Route a request and return the handler's reply."""
    domain, intent = route(text)
    handler = HANDLERS.get(intent) if intent else None
    if handler is None:
        return f"[{domain}] Thanks for reaching out. A support agent will reply shortly."
    return handler(text)
