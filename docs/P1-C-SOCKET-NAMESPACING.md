# P1-C Socket Room Namespacing

Completed: 2026-08-19

## Contract

- Socket connections require an organization-scope JWT carrying `organizationId`.
- The server stores the organization on `socket.data`; clients continue sending bare resource IDs.
- Every join, leave, and targeted emit uses `apps/backend/src/socket/rooms.ts`.
- Tenant room names always start with `org:{organizationId}`.
- Resource authorization runs inside `runAsOrganization` before a conversation or group room is joined.

## Room Inventory

| Kind | Shape |
|---|---|
| Organization | `org:{organizationId}` |
| Department | `org:{organizationId}:dept:{department}` |
| Alerts | `org:{organizationId}:alerts` |
| User | `org:{organizationId}:user:{userId}` |
| Conversation | `org:{organizationId}:conv:{conversationId}` |
| Group | `org:{organizationId}:group:{groupId}` |

The helper is used by socket handlers, OpenWA webhooks, incoming-message and campaign workers,
notification delivery, conversations, tickets, alerts, authentication, and system routes.

## Verification

`npm run build` passes. `npm run test:tenancy` reports `17/22`; the expected non-zero exit is from
the five remaining P1-D/P1-E/API assertions. All P1-C assertions pass:

- every discovered room operation uses the central organization-scoped helper;
- org A cannot join org B's conversation room;
- an event emitted for org A is not delivered to org B.
