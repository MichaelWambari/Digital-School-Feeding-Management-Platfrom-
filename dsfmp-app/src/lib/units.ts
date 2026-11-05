// Stock is always counted in kg or litres. A food can also have a pack
// size (kg per bag, litres per jerrycan), so amounts can be shown and
// entered in bags as well.

export type Measured = { unit: string; pack_size?: number | null };

function formatNumber(n: number) {
  return Number(n).toLocaleString(undefined, { maximumFractionDigits: 2 });
}

// "1,250 kg"
export function formatQty(qty: number, unit: string | null) {
  return `${formatNumber(qty)} ${unit ?? ''}`.trim();
}

// "bag" for kg foods, "jerrycan" for litres.
export function packName(food: Measured, count = 1) {
  const name = food.unit === 'litres' ? 'jerrycan' : 'bag';
  return count === 1 ? name : `${name}s`;
}

// "bags of 90 kg", or null for food that isn't bagged.
export function packDescription(food: Measured) {
  if (!food.pack_size) return null;
  return `${packName(food, 2)} of ${formatQty(food.pack_size, food.unit)}`;
}

// The amount in whole bags plus what's left over: "10 bags of 90 kg + 25 kg".
// Null for food that isn't bagged.
export function formatPacks(qty: number, food: Measured) {
  const size = food.pack_size;
  if (!size || qty <= 0) return null;
  const bags = Math.floor(Number(qty) / size + 1e-9);
  const rest = Number(qty) - bags * size;
  const restText = rest > 1e-9 ? formatQty(rest, food.unit) : null;
  if (bags === 0) return `${restText}, under 1 ${packName(food)}`;
  const bagText = `${bags} ${packName(food, bags)} of ${formatQty(size, food.unit)}`;
  return restText ? `${bagText} + ${restText}` : bagText;
}

// "900 kg · 10 bags of 90 kg", or just "900 kg" for food that isn't bagged.
export function formatStock(qty: number, food: Measured) {
  const packs = formatPacks(qty, food);
  return packs ? `${formatQty(qty, food.unit)} · ${packs}` : formatQty(qty, food.unit);
}

// What was typed, in kg or litres. Bags are multiplied out.
export function toBaseQuantity(text: string, inPacks: boolean, food: Measured) {
  const n = Number(text.trim());
  return inPacks && food.pack_size ? n * food.pack_size : n;
}
