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

    I --> LANE{"Which lanes does the<br/>edition open?<br/><i>Plan.allowedChannels</i>"}

    LANE -- "OPENWA<br/>trial · Standard" --> J
    LANE -- "WHATSAPP_CLOUD<br/>trial · Standard · Growth<br/>Business · Enterprise" --> M1

    subgraph OW ["OpenWA lane — our container, a QR"]
      J["Clicks <b>Link device</b><br/><i>organization-channels.tsx connectAndPair</i>"]
      J --> K["POST /api/channels/sessions/:name/connect<br/><i>channels.routes.ts</i>"]
      K --> L{"Guard chain<br/>(section 3)"}
      L -- refused --> LX["402 naming the upgrade,<br/>dialog stays shut"]
      L -- queued --> N["Channel → PROVISIONING<br/>job on bull:gateway-provisioning"]
      N --> P["Pairing dialog polls<br/><i>GET /sessions/:name/qr</i>"]
      P --> Q["GATEWAY_PROVISIONING<br/>“this takes about a minute”"]
      R["gateway:worker builds the container<br/><i>gateway-provisioning.worker.ts</i>"]
      R --> S1["Channel → AWAITING_QR"]
      S1 --> T["QR renders, customer scans"]
      T --> U["Channel → ACTIVE"]
    end

    subgraph MC ["Cloud API lane — their WABA, a token"]
      M1["Clicks <b>Link a Meta number</b><br/><i>meta-channel-card.tsx</i>"]
      M1 --> M2["Pastes three values:<br/>phoneNumberId, wabaId, accessToken"]
      M2 --> M3["POST /api/channels/meta/connect<br/><i>meta.service.ts connectMetaChannel</i>"]
      M3 --> M4{"Four checks<br/>(section 5)"}
      M4 -- "any of the first three fails" --> M5["Nothing saved.<br/>The reason names the field."]
      M4 -- pass --> M6["Channel ACTIVE, token in the vault,<br/>session bound.<br/><b>No container. No QR.</b>"]
    end

    N -. "only when gateway:worker is running (D-5)" .-> OX["⚠ nothing builds until<br/>somebody starts the worker"]
    OX -.-> R

    M2 -. "all three come from Business Manager,<br/>and the product helps with none of it (D-9)" .-> MX["⚠ No guided signup"]
    LANE -. "META_APP_SECRET unset, so every<br/>Cloud-API-only edition is unsellable (D-9)" .-> MY["⚠ Growth, Business, Enterprise<br/>withdrawn from sale"]

    U --> V["Messaging works"]
    M6 --> V
```

### Which lanes each edition opens

Not a customer choice — `Plan.allowedChannels`, enforced by
`channelGrantRefusal` at both connect paths. Live values, owner-editable from
the console:

| Edition | OpenWA (QR) | Cloud API (token) | |
|---|---|---|---|
| **Free trial** | yes | yes | **two lanes** — a trial runs on Standard, not on Free |
| **Standard** | yes | yes | **two lanes** — the only edition that sells both |
| **Growth** | — | yes | Meta alone |
| **Business** | — | yes | Meta alone |
| **Enterprise** | — | yes | Meta alone |
| Free (a lapsed trial) | listed | yes | see below |

**Free is listed for OpenWA and can never have one.** `allowedChannels` permits
it, but `autoProvisionGateway` is false, so the guard chain answers
PLAN_UPGRADE_REQUIRED and no container is ever built. Two columns describing one
capability, disagreeing. It is not reachable today — nobody is on Free except a
lapsed trial — but it is a contradiction in the shipped catalogue, not a rule.

**And the two facts above collide.** The Meta-only editions are withdrawn from
sale while `META_APP_SECRET` is unset, so the only sellable paid edition is
Standard — the one edition with two lanes. Of its two, the QR lane needs a
worker that nothing keeps running and the token lane needs a WABA the product does not
help anybody obtain.

**And the other thing to take from the diagram:** signup creates rows and
nothing else. A workspace costs a row; a container costs RAM for as long as it
exists, so it waits for somebody to ask.

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

## 5. Connecting a Cloud API number

No container, no queue, no QR. `connectMetaChannel` in `meta.service.ts` runs
four checks against Meta's Graph API and either saves everything or nothing.

```mermaid
flowchart TD
    P0{"vault unlocked?<br/>all three fields present?"}
    P0 -- no --> F0["Refused before any network call"]
    P0 -- yes --> P1

    P1["<b>1 of 4</b> · fetchPhoneNumber<br/>does the id resolve, and can this token see it?"]
    P1 -- fails --> F1["META_PHONE_NUMBER_INVALID<br/><i>the field most often wrong: Meta's console shows<br/>the display number beside the id</i>"]
    P1 --> P2

    P2["<b>2 of 4</b> · fetchWabaPhoneNumbers<br/>can the token manage the WABA,<br/>and does the number belong to it?"]
    P2 -- fails --> F2["META_WABA_ACCESS_DENIED<br/>or META_WABA_PHONE_MISMATCH"]
    P2 --> P3

    P3["<b>3 of 4</b> · subscribeApp<br/>subscribe our app to this WABA's webhooks"]
    P3 -- fails --> F3["META_SUBSCRIBE_FAILED — <b>fatal</b>"]
    P3 --> P4

    P4["<b>4 of 4</b> · fetchPhoneNumberStanding<br/>messaging tier and quality rating"]
    P4 -- fails --> W["Warning only. Fields stay null."]
    P4 --> SAVE
    W --> SAVE

    SAVE[("persist(): channel ACTIVE,<br/>credential encrypted in the vault,<br/>session bound to it")]
```

**Step 3 is the one worth understanding.** A valid token routes nothing on its
own — without an active webhook subscription Meta has nowhere to deliver, so the
channel sends fine and never receives. The business experiences that as
customers being ignored, and every screen in this product would show a working
connection. So a failure there aborts the whole connect rather than being saved
as a degraded state.

Step 4 is deliberately non-fatal: by then the token has proven it can read the
number, manage the WABA and subscribe the app, so refusing a demonstrably
working channel because a display banner has nothing to show would be choosing
the label over the thing.

**The channel is ACTIVE the moment those checks pass.** It used to be left
PENDING, because the send path picked the organization's single ACTIVE channel
and a second one made it ambiguous. Routing is per number now, so a Meta channel
being ACTIVE affects no number that is not bound to it — which is exactly what
lets a Standard subscriber run OpenWA on one number and Cloud API on another.

---

## 6. Which gateway a message leaves through

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

## 7. Inbound

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

## 8. What an organization is entitled to

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

## 9. What is not wired

Honest list. Each is recorded, none is a surprise.

| Gap | Consequence | Entry |
|---|---|---|
| No mail transport | Verification, password reset, dunning and suspension notices are logged, never sent. Signup survives only because the link is on screen. | D-2 |
| `gateway:worker` is started by hand or not at all | Nothing in compose or a supervisor runs it. While it is down, Connect reports "being built" truthfully and the build never starts. Run by hand on 2026-09-05 it drained the backlog into **246 failed** jobs for test organizations and produced the first real pairing. | D-5 |
| Cloud API has no *guided* connect | The endpoint and the card work. What is missing is everything before them: Business Manager, business verification, a System User token with `whatsapp_business_management`. A form is not a flow — and it is the **only** lane Growth, Business and Enterprise have. | D-9 |
| Free permits OpenWA and cannot build one | `allowedChannels` says yes, `autoProvisionGateway` says no. Two columns describing one capability, disagreeing. | — |
| `META_APP_SECRET` unset | `editionOfferability` withdraws GROWTH, BUSINESS and ENTERPRISE from sale. Only FREE and STANDARD are sellable. | D-9 |
| No numbers meter | The ladder prices per number; nothing counts them. | — |
| MAC is enforced but should not be priced | `active_contacts` blocks outbound today. The ladder meters seats and numbers instead. | D-3 |
| Plans are not versioned | Editing an edition changes every subscriber's terms silently. 0 invoices so far, so this is cheap to fix now. | — |
| Secrets in public git history | `OPENWA_API_KEY` and the database password, unrotated. | D-4 |

---

## 10. Where the rules live

| Question | One place |
|---|---|
| What is this organization entitled to? | `billing/entitlements.resolver.ts` |
| What does this edition grant? | `billing/editions.service.ts` (cache over the `Plan` table) |
| May this organization obtain this channel? | `channels/channel-entitlement.ts` |
| Can the platform operate this channel at all? | `channels/channel-viability.ts` |
| Which gateway does this number use? | `channels/channel.service.ts` |
| Should a gateway be built? | `billing/billing.service.ts` `maybeProvisionGateway` |
| May this request proceed? | `middleware/access-gate.middleware.ts` |
