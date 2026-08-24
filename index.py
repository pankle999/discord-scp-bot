import asyncio
import json
import os
import threading
import time
from http.server import BaseHTTPRequestHandler, HTTPServer
from pathlib import Path
from typing import Any

import discord
import firebase_admin
from discord import app_commands
from discord.ext import commands
from firebase_admin import credentials, firestore


DAYS = [
    "Monday",
    "Tuesday",
    "Wednesday",
    "Thursday",
    "Friday",
    "Saturday",
    "Sunday",
]

BACKUP_SLOTS = 3
STATE_LOCK = asyncio.Lock()

# Firestore document that stores the whole board state.
FIRESTORE_COLLECTION = "ssuh_bot"
FIRESTORE_DOCUMENT = "board_state"

# Fallback local file, used only if Firebase isn't configured.
STATE_FILE = Path(__file__).with_name("ssuh_reservations.json")

db = None  # set up in init_firebase()


def load_dotenv_if_present() -> None:
    env_path = Path(__file__).with_name(".env")
    if not env_path.exists():
        return

    for raw_line in env_path.read_text(encoding="utf-8").splitlines():
        line = raw_line.strip()
        if not line or line.startswith("#") or "=" not in line:
            continue
        key, value = line.split("=", 1)
        os.environ.setdefault(key.strip(), value.strip().strip('"').strip("'"))


def init_firebase() -> None:
    """Initialize the Firebase Admin SDK using the FIREBASE_SERVICE_ACCOUNT env var.

    FIREBASE_SERVICE_ACCOUNT should contain the full JSON contents of a
    Firebase service account key (as a single-line string).
    """
    global db

    raw_credentials = os.environ.get("FIREBASE_SERVICE_ACCOUNT")
    if not raw_credentials:
        print("FIREBASE_SERVICE_ACCOUNT not set; falling back to local JSON file storage.")
        return

    try:
        service_account_info = json.loads(raw_credentials)
    except json.JSONDecodeError as error:
        raise RuntimeError(
            "FIREBASE_SERVICE_ACCOUNT is not valid JSON. Make sure it's the full "
            "service account JSON pasted as a single-line string."
        ) from error

    cred = credentials.Certificate(service_account_info)
    firebase_admin.initialize_app(cred)
    db = firestore.client()
    print("Firebase initialized; using Firestore for state storage.")


def empty_state() -> dict[str, Any]:
    return {
        "message": {"channel_id": None, "message_id": None},
        "ssuh": {day: None for day in DAYS},
        "backup": {day: [None for _ in range(BACKUP_SLOTS)] for day in DAYS},
    }


def normalize_state(state: dict[str, Any]) -> dict[str, Any]:
    fresh = empty_state()
    fresh["message"].update(state.get("message", {}))

    for day in DAYS:
        fresh["ssuh"][day] = state.get("ssuh", {}).get(day)

        saved_backups = state.get("backup", {}).get(day, [])
        for index in range(BACKUP_SLOTS):
            if index < len(saved_backups):
                fresh["backup"][day][index] = saved_backups[index]

    return fresh


def load_state() -> dict[str, Any]:
    if db is not None:
        doc = db.collection(FIRESTORE_COLLECTION).document(FIRESTORE_DOCUMENT).get()
        if not doc.exists:
            return empty_state()
        return normalize_state(doc.to_dict() or {})

    # Fallback: local file (won't persist across Render redeploys).
    if not STATE_FILE.exists():
        return empty_state()

    with STATE_FILE.open("r", encoding="utf-8") as file:
        return normalize_state(json.load(file))


def save_state(state: dict[str, Any]) -> None:
    normalized = normalize_state(state)

    if db is not None:
        db.collection(FIRESTORE_COLLECTION).document(FIRESTORE_DOCUMENT).set(normalized)
        return

    # Fallback: local file.
    STATE_FILE.write_text(
        json.dumps(normalized, indent=2),
        encoding="utf-8",
    )


def mention(user_id: int | None) -> str:
    return f"<@{user_id}>" if user_id else ""


def build_board_embed(state: dict[str, Any]) -> discord.Embed:
    sections: list[str] = []

    for day in DAYS:
        ssuh = mention(state["ssuh"][day])
        backups = ", ".join(
            f"{index + 1}. {mention(user_id)}".strip()
            for index, user_id in enumerate(state["backup"][day])
        )

        sections.append(
            f"## {day}\n"
            f"**SSUH:** {ssuh}\n"
            f"**Back-up:** {backups}"
        )

    embed = discord.Embed(
        description="\n\n".join(sections),
        color=discord.Color.dark_embed(),
    )
    embed.set_footer(text="Use the buttons below to reserve or remove your spot.")
    return embed


async def refresh_board(client: discord.Client, state: dict[str, Any] | None = None) -> bool:
    state = normalize_state(state or load_state())
    channel_id = state["message"].get("channel_id")
    message_id = state["message"].get("message_id")

    if not channel_id or not message_id:
        return False

    try:
        channel = client.get_channel(int(channel_id)) or await client.fetch_channel(int(channel_id))
        if not isinstance(channel, discord.abc.Messageable):
            return False

        message = await channel.fetch_message(int(message_id))
        await message.edit(embed=build_board_embed(state), view=BoardView())
        return True
    except discord.HTTPException:
        return False


def remove_user_from_state(state: dict[str, Any], user_id: int) -> int:
    removed = 0

    for day in DAYS:
        if state["ssuh"][day] == user_id:
            state["ssuh"][day] = None
            removed += 1

        for index, backup_user_id in enumerate(state["backup"][day]):
            if backup_user_id == user_id:
                state["backup"][day][index] = None
                removed += 1

    return removed


class SSUHDaySelect(discord.ui.Select):
    def __init__(self) -> None:
        options = [
            discord.SelectOption(
                label=day,
                value=day,
            )
            for day in DAYS
        ]
        super().__init__(
            placeholder="Choose a day for SSUH",
            min_values=1,
            max_values=1,
            options=options,
        )

    async def callback(self, interaction: discord.Interaction) -> None:
        day = self.values[0]
        user_id = interaction.user.id

        async with STATE_LOCK:
            state = load_state()
            current_user = state["ssuh"][day]

            if current_user and current_user != user_id:
                await interaction.response.edit_message(
                    content=f"{day} already has SSUH reserved by <@{current_user}>.",
                    view=None,
                )
                return

            state["ssuh"][day] = user_id
            save_state(state)

        await refresh_board(interaction.client, state)
        await interaction.response.edit_message(
            content=f"You reserved **{day}** as SSUH.",
            view=None,
        )


class BackupSlotSelect(discord.ui.Select):
    def __init__(self) -> None:
        options: list[discord.SelectOption] = []

        for day in DAYS:
            for index in range(BACKUP_SLOTS):
                slot = index + 1
                options.append(
                    discord.SelectOption(
                        label=f"{day} backup {slot}",
                        value=f"{day}|{index}",
                    )
                )

        super().__init__(
            placeholder="Choose a day and backup slot",
            min_values=1,
            max_values=1,
            options=options,
        )

    async def callback(self, interaction: discord.Interaction) -> None:
        day, raw_index = self.values[0].split("|", 1)
        index = int(raw_index)
        user_id = interaction.user.id

        async with STATE_LOCK:
            state = load_state()
            current_user = state["backup"][day][index]

            if current_user and current_user != user_id:
                await interaction.response.edit_message(
                    content=(
                        f"{day} backup {index + 1} is already reserved by "
                        f"<@{current_user}>."
                    ),
                    view=None,
                )
                return

            state["backup"][day][index] = user_id
            save_state(state)

        await refresh_board(interaction.client, state)
        await interaction.response.edit_message(
            content=f"You reserved **{day} backup {index + 1}**.",
            view=None,
        )


class OneSelectView(discord.ui.View):
    def __init__(self, select: discord.ui.Select) -> None:
        super().__init__(timeout=180)
        self.add_item(select)


class BoardView(discord.ui.View):
    def __init__(self) -> None:
        super().__init__(timeout=None)

    @discord.ui.button(
        label="Reserve SSUH",
        style=discord.ButtonStyle.primary,
        custom_id="ssuh_board:reserve_ssuh",
    )
    async def reserve_ssuh(
        self,
        interaction: discord.Interaction,
        _button: discord.ui.Button,
    ) -> None:
        await interaction.response.send_message(
            "Choose the day you want to reserve as SSUH.",
            view=OneSelectView(SSUHDaySelect()),
            ephemeral=True,
        )

    @discord.ui.button(
        label="Reserve Back-up",
        style=discord.ButtonStyle.primary,
        custom_id="ssuh_board:reserve_backup",
    )
    async def reserve_backup(
        self,
        interaction: discord.Interaction,
        _button: discord.ui.Button,
    ) -> None:
        await interaction.response.send_message(
            "Choose the day and backup slot you want.",
            view=OneSelectView(BackupSlotSelect()),
            ephemeral=True,
        )

    @discord.ui.button(
        label="Remove Me",
        style=discord.ButtonStyle.danger,
        custom_id="ssuh_board:remove_me",
    )
    async def remove_me(
        self,
        interaction: discord.Interaction,
        _button: discord.ui.Button,
    ) -> None:
        async with STATE_LOCK:
            state = load_state()
            removed = remove_user_from_state(state, interaction.user.id)
            save_state(state)

        await refresh_board(interaction.client, state)

        if removed:
            message = f"Removed you from {removed} reservation(s)."
        else:
            message = "You did not have any reservations on the board."

        await interaction.response.send_message(message, ephemeral=True)

    @discord.ui.button(
        label="Refresh",
        style=discord.ButtonStyle.secondary,
        custom_id="ssuh_board:refresh",
    )
    async def refresh(
        self,
        interaction: discord.Interaction,
        _button: discord.ui.Button,
    ) -> None:
        state = load_state()
        await interaction.response.edit_message(embed=build_board_embed(state), view=BoardView())


class SSUHBot(commands.Bot):
    async def setup_hook(self) -> None:
        self.add_view(BoardView())

        guild_id = os.environ.get("GUILD_ID")
        if guild_id:
            guild = discord.Object(id=int(guild_id))
            self.tree.copy_global_to(guild=guild)
            await self.tree.sync(guild=guild)
        else:
            await self.tree.sync()


intents = discord.Intents.default()
bot = SSUHBot(command_prefix="!", intents=intents)


@bot.event
async def on_ready() -> None:
    print(f"Logged in as {bot.user} (ID: {bot.user.id if bot.user else 'unknown'})")


@bot.tree.command(
    name="ssuh_board",
    description="Post the weekly SSUH reservation board in this channel.",
)
@app_commands.checks.has_permissions(manage_messages=True)
async def ssuh_board(interaction: discord.Interaction) -> None:
    if interaction.channel is None:
        await interaction.response.send_message(
            "Run this command inside a server text channel.",
            ephemeral=True,
        )
        return

    await interaction.response.defer(ephemeral=True, thinking=True)

    state = load_state()
    message = await interaction.channel.send(embed=build_board_embed(state), view=BoardView())
    state["message"] = {"channel_id": message.channel.id, "message_id": message.id}
    save_state(state)

    await interaction.followup.send("SSUH board posted.", ephemeral=True)


@bot.tree.command(
    name="ssuh_reset",
    description="Clear every SSUH and backup reservation.",
)
@app_commands.checks.has_permissions(manage_messages=True)
async def ssuh_reset(interaction: discord.Interaction) -> None:
    async with STATE_LOCK:
        state = load_state()
        message = state["message"]
        state = empty_state()
        state["message"] = message
        save_state(state)

    await refresh_board(interaction.client, state)
    await interaction.response.send_message("All reservations were cleared.", ephemeral=True)


@ssuh_board.error
@ssuh_reset.error
async def reservation_command_error(
    interaction: discord.Interaction,
    error: app_commands.AppCommandError,
) -> None:
    if isinstance(error, app_commands.MissingPermissions):
        message = "You need the Manage Messages permission to use that command."
    else:
        message = f"Something went wrong: {error}"

    if interaction.response.is_done():
        await interaction.followup.send(message, ephemeral=True)
    else:
        await interaction.response.send_message(message, ephemeral=True)


def run_health_server() -> None:
    port = int(os.environ.get("PORT", 8080))

    class Handler(BaseHTTPRequestHandler):
        def do_GET(self):
            self.send_response(200)
            self.end_headers()
            self.wfile.write(b"OK")

        def log_message(self, *args):
            pass  # silence request logging

    HTTPServer(("0.0.0.0", port), Handler).serve_forever()


def run_bot_with_backoff(token: str) -> None:
    """Run the bot, backing off with increasing delay on login failures.

    Discord's login rate limit (HTTP 429 on /users/@me) can be triggered by
    factors outside our control (e.g. shared-host IP throttling). If Render
    just restarts the process immediately after a crash, we hammer the login
    endpoint again and again, which extends the block instead of letting it
    clear. This loop waits it out with exponential backoff instead.
    """
    delay_seconds = 60  # start at 1 minute
    max_delay_seconds = 30 * 60  # cap at 30 minutes

    while True:
        try:
            bot.run(token)
            # bot.run() only returns after a clean shutdown (e.g. bot.close()).
            # Treat that as intentional and stop the loop.
            return
        except discord.errors.LoginFailure:
            # Bad/revoked token - retrying won't help, fail loudly instead of looping.
            print(
                "Login failed: the token was rejected (invalid or reset). "
                "Fix DISCORD_BOT_TOKEN and redeploy - not retrying."
            )
            raise
        except discord.errors.HTTPException as error:
            if getattr(error, "status", None) == 429:
                print(
                    f"Hit Discord's rate limit while logging in. "
                    f"Waiting {delay_seconds}s before retrying..."
                )
            else:
                print(
                    f"Discord HTTP error during startup: {error}. "
                    f"Waiting {delay_seconds}s before retrying..."
                )
            time.sleep(delay_seconds)
            delay_seconds = min(delay_seconds * 2, max_delay_seconds)
        except Exception as error:  # noqa: BLE001 - last resort, keep the loop alive
            print(
                f"Unexpected error during startup: {error}. "
                f"Waiting {delay_seconds}s before retrying..."
            )
            time.sleep(delay_seconds)
            delay_seconds = min(delay_seconds * 2, max_delay_seconds)


if __name__ == "__main__":
    load_dotenv_if_present()
    init_firebase()

    token = os.environ.get("DISCORD_BOT_TOKEN")
    if not token:
        raise RuntimeError(
            "Set DISCORD_BOT_TOKEN in your environment or in outputs/.env before running."
        )

    threading.Thread(target=run_health_server, daemon=True).start()
    run_bot_with_backoff(token)
