import type { SelectOption } from "@opentui/core";
import type { ModelOption } from "../../core/types.ts";
import { palette } from "../theme.ts";

export function ModelPicker(props: {
  models: ModelOption[];
  current: string;
  width: number;
  height: number;
  onChoose: (id: string) => void;
}) {
  // One row per model, name only: ids, context sizes and effort levels stay
  // out of the list so it reads at a glance.
  const options: SelectOption[] = props.models.map((m) => ({
    name: m.id === props.current ? `● ${m.name}` : `  ${m.name}`,
    description: "",
    value: m.id,
  }));
  const selectedIndex = Math.max(0, props.models.findIndex((m) => m.id === props.current));
  const boxWidth = Math.min(props.width - 4, 56);
  const boxHeight = Math.min(props.height - 4, options.length + 4);
  return (
    <box
      position="absolute"
      top={Math.max(0, Math.floor((props.height - boxHeight) / 2))}
      left={Math.max(0, Math.floor((props.width - boxWidth) / 2))}
      width={boxWidth}
      height={boxHeight}
      flexDirection="column"
      border
      borderStyle="rounded"
      borderColor={palette.accent}
      backgroundColor={palette.surfaceRaised}
      title=" model "
      titleColor={palette.accent}
      zIndex={20}
      paddingX={1}
    >
      {options.length === 0 ? (
        <text fg={palette.textDim}>No models listed. Use /model &lt;id&gt; to set one directly.</text>
      ) : (
        <select
          focused
          options={options}
          selectedIndex={selectedIndex}
          backgroundColor={palette.surfaceRaised}
          focusedBackgroundColor={palette.surfaceRaised}
          textColor={palette.text}
          focusedTextColor={palette.text}
          selectedBackgroundColor={palette.accentSoft}
          selectedTextColor={palette.text}
          showDescription={false}
          showScrollIndicator
          wrapSelection
          onSelect={(_index, option) => {
            if (option && typeof option.value === "string") props.onChoose(option.value);
          }}
          flexGrow={1}
        />
      )}
      <text fg={palette.textFaint} wrapMode="none">
        ↑/↓ · Enter · Esc · /model &lt;id&gt; for a custom id
      </text>
    </box>
  );
}
