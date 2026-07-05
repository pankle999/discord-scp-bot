import asyncio
import json
import os
from pathlib import Path
from typing import Any

import discord
from discord import app_commands
from discord.ext import commands


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
STATE_FILE = Path(__file__).with_name("ssuh_reservations.json")
STATE_LOCK = asyncio.Lock()


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
    if not STATE_FILE.exists():
        return empty_state()

    with STATE_FILE.open("r", encoding="utf-8") as file:
        return normalize_state(json.load(file))


def save_state(state: dict[str, Any]) -> None:
    STATE_FILE.write_text(
        json.dumps(normalize_state(state), indent=2),
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


if __name__ == "__main__":
    load_dotenv_if_present()
    token = os.environ.get("DISCORD_BOT_TOKEN")

    if not token:
        raise RuntimeError(
            "Set DISCORD_TOKEN in your environment or in outputs/.env before running."
        )

    bot.run(token)
