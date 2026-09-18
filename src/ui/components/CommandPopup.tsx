import type { CommandSpec } from "../commands.ts";
import { palette } from "../theme.ts";

/**
 * Slash-command selector shown above the composer while the user types "/…",
 * or in "help" mode listing every command. Keyboard-only: the App owns the
 * cursor and dispatches the selection.
 */
export function CommandPopup(props: { commands: CommandSpec[]; cursor: number; query: string; help: boolean; width: number }) {
  const cards = props.commands;
  const boxWidth = Math.min(props.width - 4, 64);
  return (
    <box
      flexDirection="column"
      flexShrink={0}
      marginX={2}
      width={boxWidth}
      border
      borderStyle="rounded"
      borderColor={palette.borderSoft}
      backgroundColor={palette.surface}
      paddingX={1}
      title={props.help ? " commands " : ` /${props.query} `}
      titleColor={palette.textDim}
    >
      {cards.length === 0 ? (
        <text fg={palette.textDim} wrapMode="none">
          no command matches /{props.query}
        </text>
      ) : (
        cards.map((c, i) => {
          const selected = i === props.cursor;
          return (
            <text key={c.name} wrapMode="none" bg={selected ? palette.surfaceRaised : undefined}>
              <span fg={selected ? palette.accent : palette.textFaint}>{selected ? "▸ " : "  "}</span>
              <span fg={selected ? palette.text : palette.textDim}>{c.usage.padEnd(14)}</span>
              <span fg={selected ? palette.textDim : palette.textFaint}>{c.description}</span>
            </text>
          );
        })
      )}
      <text fg={palette.textFaint} wrapMode="none">
        {props.help ? "↑/↓ choose · Enter run · Esc close" : "↑/↓ choose · Tab or Enter select · Esc close"}
      </text>
    </box>
  );
}
