# How RabiTech works, end to end

What actually happens, in the code as it stands at `e5b63b32`. Every box names
the file that does the work, so this can be checked rather than believed.

**Two conventions, because a diagram that mixes them is worse than none:**

- Solid lines and plain boxes are **wired and running**.
- Dashed lines and boxes marked ⚠ are **not wired in this environment** — the
  code exists, the thing that would run it does not. Each names its DECISIONS
  entry.

---

## 1. The customer journey

```mermaid
flowchart TD
    A["Visitor picks an edition<br/><i>app/pricing/page.tsx</i>"] --> B

    B["POST /api/billing/signup<br/><i>billing.service.ts createSignup</i>"] --> C
    C[("One transaction:<br/>organization, admin, team,<br/>workspace, channel row, number,<br/>config, subscription")] --> D

    D{"Paid edition?"}
    D -- yes --> E["Checkout via the provider<br/><i>provider-registry.ts</i><br/>manual today"]
    D -- no --> F
    E --> F

    F["Signup screen shows the<br/>verification link on the page<br/><i>signup/page.tsx:121</i>"]
    F -. "no mail transport (D-2)" .-> GX["⚠ Email never sent"]

    F --> H["Customer logs in<br/><i>POST /api/auth/login</i>"]
    H --> I["Dashboard.<br/>No container exists yet."]

    I --> J["Clicks <b>Link device</b><br/><i>organization-channels.tsx connectAndPair</i>"]
    J --> K["POST /api/channels/sessions/:name/connect<br/><i>channels.routes.ts</i>"]
    K --> L{"Guard chain<br/>(section 3)"}

    L -- refused --> M["402 naming the upgrade,<br/>dialog stays shut"]
    L -- queued --> N["Channel → PROVISIONING<br/>job on bull:gateway-provisioning"]

    N -. "worker not running here (D-5)" .-> OX["⚠ 236 jobs waiting"]
    N --> P["Pairing dialog polls<br/><i>GET /sessions/:name/qr</i>"]
    P --> Q["GATEWAY_PROVISIONING<br/>“this takes about a minute”"]

    OX -.-> R["gateway:worker builds the container<br/><i>gateway-provisioning.worker.ts</i>"]
    R --> S["Channel → AWAITING_QR"]
    S --> T["QR renders, customer scans"]
    T --> U["Channel → ACTIVE. Messaging works."]
```

**The one thing to take from this diagram:** signup creates rows and nothing
else. A workspace costs a row; a container costs RAM for as long as it exists,
so it waits for somebody to ask.

---

## 2. What signup actually creates

One transaction in `createSignup`, in dependency order:

| Row | Note |
|---|---|
| `Organization` | `status: ACTIVE`. Not PENDING — manual activation was removed in `b8755d82`. |
| `Identity` + `User` | The admin. Identity is global (login); User is per organization. |
| `Team` "General" | |
| `Workspace` | The default one, id derived as `ws_<organizationId>` by `defaultWorkspaceData`. |
| `WorkspaceMember` | Mirrors the organization role rather than defaulting. |
| **`OrganizationChannel`** | `kind: OPENWA`, `status: PENDING`, **empty `baseUrl`, empty `apiKeyEnc`**. A row, not a gateway. |
| **`WhatsappSession`** | The first number, **bound to that channel** (`channelId`). Created after it, for that reason. |
| `OrganizationConfig` | Limits copied from the edition by `applyPlanLimits`. |
| `OrganizationBranding`, `WorkingHours`, `OrgSequence` | |
| `Subscription` | `TRIALING` for a trial, else `MANUAL_REVIEW` until a payment event. |
| `EmailVerificationToken` | Consumed by `/api/billing/verify-email`. |

---

## 3. The provisioning guard chain

Every gate a Connect click passes, in order — `maybeProvisionGateway`,
`billing.service.ts`:

```mermaid
flowchart TD
    A["connect requested"] --> B{"organization exists?"}
    B -- no --> X1["UNKNOWN_ORGANIZATION → 500"]
    B -- yes --> C{"isPaidPlan?"}
    C -- no --> X2["PLAN_UPGRADE_REQUIRED → 402<br/>FREE never provisions (D-7)"]
    C -- yes --> D{"edition's<br/>autoProvisionGateway?"}
    D -- no --> X2
    D -- yes --> E{"channelGrantRefusal:<br/>does the edition allow OPENWA?"}
    E -- no --> X3["CHANNEL_NOT_PERMITTED → 402<br/>grandfathers an already-ACTIVE channel"]
    E -- yes --> F{"channel row exists?"}
    F -- no --> X4["NO_CHANNEL_ROW → 500"]
    F -- yes --> G{"already ACTIVE,<br/>AWAITING_QR or PROVISIONING?"}
    G -- yes --> X5["ALREADY_IN_FLIGHT → 200 with the state"]
    G -- no --> H["organization → PROVISIONING<br/>channel → PROVISIONING<br/>queue the job"]
```

Email verification is **not** in this chain, deliberately and transitionally —
D-8 carries the expiry condition.

---

## 4. Gateway lifecycle

`GatewayProvisioningState`, driven by `gateway-provisioning.service.ts`:

```mermaid
stateDiagram-v2
    [*] --> PENDING: signup creates the row
    PENDING --> PROVISIONING: customer clicks Connect
    PROVISIONING --> AWAITING_QR: container up, session created
    AWAITING_QR --> ACTIVE: QR scanned
    ACTIVE --> SUSPENDED: payment failed, or expiry
    SUSPENDED --> PROVISIONING: resume
    PROVISIONING --> FAILED: build failed
    AWAITING_QR --> FAILED: never paired, expired
    FAILED --> PROVISIONING: retry
```

**`suspend` stops the container and keeps every volume** — the paired session
survives, so returning does not mean re-scanning a QR. `destroy` is a separate
action that also deletes the organization.

---

## 5. Which gateway a message leaves through

The C1 invariant, `channel.service.ts`:

> An outbound message leaves through the gateway of the session its
> conversation belongs to.

```mermaid
flowchart LR
    A["ChannelService.sendText(routingKey, …)<br/>16 call sites, all pass the session name"] --> B
    B["channelForSession(routingKey)"] --> C{"session found?"}
    C -- no --> E1["SESSION_UNKNOWN"]
    C -- yes --> D{"bound to a channel?"}
    D -- no --> E2["SESSION_NOT_BOUND<br/><i>never a fallback</i>"]
    D -- yes --> E{"channel ACTIVE?"}
    E -- no --> E3["CHANNEL_NOT_ACTIVE"]
    E -- yes --> F{"kind"}
    F -- OPENWA --> G["OpenWASendAdapter"]
    F -- WHATSAPP_CLOUD --> H["createMetaAdapter(credential)<br/>scoped to this channel"]
    G --> I["assertSendable → meteredSend → wire"]
    H --> I
```

One organization may hold one OpenWA channel **and** one Cloud API channel, both
ACTIVE, with different numbers on each. There is no organization-level "sending
channel" any more; `POST /channels/active` was deleted, not renamed.

---

## 6. Inbound

```mermaid
flowchart LR
    A1["OpenWA container"] -->|"POST /webhooks/openwa/:webhookToken"| B1["openwa.webhook.ts<br/>resolves the org from the token"]
    A2["Meta Cloud API"] -->|"POST /webhooks/meta"| B2["meta.webhook.ts<br/>X-Hub-Signature-256"]
    B1 --> C["queueIncomingMessage"]
    B2 --> C
    C --> D["incoming-message.worker.ts"]
    D --> E["Contact / Conversation / Message<br/>in the session's workspace"]
    E --> F["Auto-replies, workflows,<br/>escalation, CSAT"]
```

---

## 7. What an organization is entitled to

`resolveEntitlements`, one resolution order, read at every enforcement site:

```
live override  →  active subscription  →  Organization.tier  →  FREE
```

Overrides are resolved **at read time and never written through**, so expiry
cannot fail and the audit trail cannot disagree with what is enforced.

| Quota | Enforced by | Shown by | Same source? |
|---|---|---|---|
| Metered (6) | `assertMetricAvailable` | `GET /api/usage/current` | yes |
| Seats | `assertSeatAvailable` | `GET /api/usage/seats` | yes |
| Workspaces | `POST /api/workspaces` → 402 | `GET /api/workspaces` | yes |
| **WhatsApp numbers** | **nothing** | nothing | — |

---

## 8. What is not wired

Honest list. Each is recorded, none is a surprise.

| Gap | Consequence | Entry |
|---|---|---|
| No mail transport | Verification, password reset, dunning and suspension notices are logged, never sent. Signup survives only because the link is on screen. | D-2 |
| `gateway:worker` runs nowhere | Jobs queue and nothing consumes them: **236 waiting**. Connect reports "being built" truthfully and the build never starts. | D-5 |
| Cloud API has no connect screen | OpenWA is self-serve; Meta is a form for three values the customer must fetch from Business Manager unaided. Growth sells both. | D-9 |
| `META_APP_SECRET` unset | `editionOfferability` withdraws GROWTH, BUSINESS and ENTERPRISE from sale. Only FREE and STANDARD are sellable. | D-9 |
| No numbers meter | The ladder prices per number; nothing counts them. | — |
| MAC is enforced but should not be priced | `active_contacts` blocks outbound today. The ladder meters seats and numbers instead. | D-3 |
| Plans are not versioned | Editing an edition changes every subscriber's terms silently. 0 invoices so far, so this is cheap to fix now. | — |
| Secrets in public git history | `OPENWA_API_KEY` and the database password, unrotated. | D-4 |

---

## 9. Where the rules live

| Question | One place |
|---|---|
| What is this organization entitled to? | `billing/entitlements.resolver.ts` |
| What does this edition grant? | `billing/editions.service.ts` (cache over the `Plan` table) |
| May this organization obtain this channel? | `channels/channel-entitlement.ts` |
| Can the platform operate this channel at all? | `channels/channel-viability.ts` |
| Which gateway does this number use? | `channels/channel.service.ts` |
| Should a gateway be built? | `billing/billing.service.ts` `maybeProvisionGateway` |
| May this request proceed? | `middleware/access-gate.middleware.ts` |
