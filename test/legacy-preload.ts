// Historical execution tests explicitly exercise the old demo mode. Strategy integration
// tests opt into the production default in their own isolated config.
process.env.STRATEGY_ENABLED = "false";
