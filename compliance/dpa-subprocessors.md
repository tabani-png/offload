# Data processing agreement: sub-processors

> **Not legal advice; review by counsel before use.** Offload is the processor; each customer is the controller of its
> employees' data. This list belongs in the DPA's sub-processor annex. Confirm every entry, region and retention term
> with the vendor's current terms before signing.

| sub-processor | what it does for Offload | data it receives | retention / notes |
|---|---|---|---|
| Anthropic (Claude Managed Agents) | runs cloud workers for role workflows | workflow definitions, step inputs and outputs of cloud runs, role-identity mail content the run handles | **Not covered by zero data retention (not ZDR).** Inputs and outputs are kept by Anthropic under its standard retention terms; state this to customers. |
| Composio | holds OAuth connections for company and personal-allowed tools; executes tool calls | connection credentials (held by Composio, only references in Offload), tool call payloads of runs | per Composio's DPA; credentials deleted when the connection is deleted |
| WorkOS | sign-in (AuthKit), SSO and directory sync | employee name, email, directory group membership, sign-in events | per WorkOS's DPA |
| Hosting provider for the control plane | runs the database and API | everything in the control plane data map (`compliance/data-map.md`) | **TBD**: host not chosen yet; region, encryption at rest and backup retention to be filled in |

## What no sub-processor receives
Raw activity from the Mac: it never leaves the employee's computer.

## Changes
Customers are told about a new sub-processor at least 30 days before it starts processing and may object.
