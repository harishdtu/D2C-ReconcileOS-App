export function formatMoney(amount: string, currency: string): string {
  const [whole = "0", fractional = "00"] = amount.split(".");
  const negative = whole.startsWith("-");
  const digits = negative ? whole.slice(1) : whole;
  let grouped: string;
  if (currency === "INR" && digits.length > 3) {
    let prefix = digits.slice(0, -3);
    const groups = [];
    while (prefix.length > 2) {
      groups.unshift(prefix.slice(-2));
      prefix = prefix.slice(0, -2);
    }
    if (prefix) groups.unshift(prefix);
    grouped = `${groups.join(",")},${digits.slice(-3)}`;
  } else {
    grouped = digits.replace(/\B(?=(\d{3})+(?!\d))/g, ",");
  }
  const symbol = new Intl.NumberFormat("en", {
    style: "currency",
    currency,
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  }).formatToParts(0).find((part) => part.type === "currency")?.value ?? currency;
  return `${negative ? "-" : ""}${symbol}${grouped}.${fractional.padEnd(2, "0").slice(0, 2)}`;
}

export function formatDate(value: string | Date | null | undefined): string {
  if (!value) return "—";
  const date = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(date.getTime())) return "—";
  return new Intl.DateTimeFormat("en-IN", {
    day: "2-digit",
    month: "short",
    year: "numeric",
  }).format(date);
}

export function humanize(value: string): string {
  return value
    .toLowerCase()
    .split("_")
    .map((word) => word.charAt(0).toUpperCase() + word.slice(1))
    .join(" ");
}
