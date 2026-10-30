/** Original implementation notes, not a reproduction of the textbook. */
export const RULEBOOK = {
  version: "cartea-market-making-v1",
  source: "Algorithmic and High-Frequency Trading, Cartea, Jaimungal and Penalva (2015), chapters 10 and 12",
  reference: "https://sebastian.statistics.utoronto.ca/books/algo-and-hf-trading/",
  rules: [
    "Choose the inventory you want over the forecast horizon using order flow, depth and price changes. A direction probability is not a profit estimate.",
    "A passive fill can select against us. Earning the full spread requires a successful round trip; one fill does not earn the full spread.",
    "Account for inventory, pending orders, volatility, fees, gas and exit costs. Increase caution as inventory or volatility rises.",
    "The execution gate may skip your chosen side. Never reverse a blocked forecast just to force a trade.",
    "Keep an economically sound resting order to preserve queue priority and gas. Cancel stale, loss-limited or adverse orders.",
    "Only matured observations may inform estimates. No historical fit or model confidence guarantees future profit.",
  ],
} as const;
