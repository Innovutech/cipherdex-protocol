# Periphery

Periphery interfaces are intentionally kept separate from pool settlement
logic. The current public CPMM quoter and router are Solidity contracts under
`contracts/` so Hardhat compiles their imports and factory gate together with
the protocol. This directory is the integration boundary for future
periphery-only SDK, routing and adapter documentation.

The current confidential pool is called directly. COTI authenticated inputs
bind the sender, target and selector, so a forwarding router must not be added
until an official delegation primitive preserves that binding.
