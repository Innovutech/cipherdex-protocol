# Periphery

Periphery interfaces are intentionally kept separate from pool settlement
logic. The current public CPMM quoter and router are Solidity contracts under
`contracts/` so Hardhat compiles their imports and factory gate together with
the protocol. This directory is the integration boundary for future
periphery-only SDK, routing and adapter documentation.

Confidential pools retain direct calls and also accept narrow raw-GT quote and
settlement calls only from the one `ConfidentialBestExecutionRouter` configured
by their canonical factory. User inputs bind to the router and exact selector;
the router validates once and reuses the transaction-scoped GT value. This is
not generic forwarding: callers cannot supply pools or original-sender data, and
each selected pool remains authoritative for fees, slippage and settlement.
