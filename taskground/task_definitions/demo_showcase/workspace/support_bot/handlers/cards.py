"""Replies for card requests."""


def handle_lost_or_stolen_card(text: str) -> str:
    return "We've frozen your card. You can order a replacement from Cards > Replace."


def handle_activate_my_card(text: str) -> str:
    return "Open Cards, tap your new card and follow the activation steps."


def handle_pin_blocked(text: str) -> str:
    return "Your PIN can be unblocked at any ATM using the PIN services menu."


def handle_card_arrival(text: str) -> str:
    return "Cards usually arrive within 5 working days. Track delivery under Cards > Status."


def handle_card_not_working(text: str) -> str:
    return "Please check the card is not frozen and that the merchant accepts it."


HANDLERS = {
    "lost_or_stolen_card": handle_lost_or_stolen_card,
    "activate_my_card": handle_activate_my_card,
    "pin_blocked": handle_pin_blocked,
    "card_arrival": handle_card_arrival,
    "card_not_working": handle_card_not_working,
}
