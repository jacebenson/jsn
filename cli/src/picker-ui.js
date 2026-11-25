export const PICKER_HELP = '↑↓ navigate • ⏎ select • type to search • Esc cancel';

export function pickerRows(choices, active, { picked } = {}) {
  const lines = [];
  choices.forEach((choice, index) => {
    if (choice.section && choice.section !== choices[index - 1]?.section) {
      if (index) lines.push('');
      lines.push(`  ${choice.section}`);
    }
    if (choice.separator) { lines.push(`  ${choice.name}`); return; }
    const check = picked ? `[${picked.has(choice) ? 'x' : ' '}] ` : '';
    lines.push(`${index === active ? '❯' : ' '} ${check}${choice.name}${choice.disabled ? ' (disabled)' : ''}`);
    if (index === active && choice.description) lines.push(`  ${choice.description}`);
  });
  return lines;
}

export function pickerFooter({ checkbox = false, more = false } = {}) {
  return ['', `${PICKER_HELP}${checkbox ? ' • Space toggle' : ''}${more ? ' • ↓ load more' : ''}`];
}
