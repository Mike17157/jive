"""Replies for transfer requests."""


def handle_cancel_transfer(text: str) -> str:
    return "Pending transfers can be cancelled from Payments > Activity before they settle."


def handle_failed_transfer(text: str) -> str:
    return "Failed transfers are returned within 2 working days. Check the recipient details and retry."


def handle_pending_transfer(text: str) -> str:
    return "Most transfers leave pending within one working day."


def handle_transfer_timing(text: str) -> str:
    return "Domestic transfers arrive within hours; international ones take up to 5 working days."


HANDLERS = {
    "cancel_transfer": handle_cancel_transfer,
    "failed_transfer": handle_failed_transfer,
    "pending_transfer": handle_pending_transfer,
    "transfer_timing": handle_transfer_timing,
}
