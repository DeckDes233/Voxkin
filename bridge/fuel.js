// 主世界木板可作燃料；绯红和诡异木板不可燃，木棍不参与批次选择。
export const FUEL_BURN = Object.freeze({
  coal: 8, charcoal: 8, wooden_pickaxe: 1,
  ...Object.fromEntries(['oak', 'spruce', 'birch', 'jungle', 'acacia', 'dark_oak', 'mangrove', 'cherry', 'bamboo'].map(name => [`${name}_planks`, 1.5])),
});

export function selectFuel(items, rounds = [1], preferred = '') {
  const stock = name => items.filter(item => item.name === name).reduce((sum, item) => sum + item.count, 0);
  for (const [name, burn] of Object.entries(FUEL_BURN)) {
    if (name === 'wooden_pickaxe' && preferred !== name) continue;
    if (preferred && name !== preferred) continue;
    const need = rounds.reduce((sum, count) => sum + Math.ceil(count / burn), 0);
    if (stock(name) >= need) return items.find(item => item.name === name);
  }
  return null;
}
