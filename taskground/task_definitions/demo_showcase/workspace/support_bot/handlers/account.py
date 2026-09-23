"""Replies for account and security requests."""


def handle_passcode_forgotten(text: str) -> str:
    return "Tap 'Forgot passcode' on the login screen to reset it with your email."


def handle_terminate_account(text: str) -> str:
    return "You can close your account under Profile > Account > Close account."


def handle_verify_my_identity(text: str) -> str:
    return "Go to Profile > Verify identity and have your ID document ready."


HANDLERS = {
    "passcode_forgotten": handle_passcode_forgotten,
    "terminate_account": handle_terminate_account,
    "verify_my_identity": handle_verify_my_identity,
}
