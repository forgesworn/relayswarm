# Shared upload allowance

[Documentation](README.md) · [Operations](OPERATIONS.md) ·
[Delivery requirements](PRODUCTION-READINESS.md)

The current source implements an optional account allowance shared across
devices, supporting Nostr sign-in and host website accounts. The
[controlled Chrome journey](../spikes/results/account-budget-implementation-20261014.json)
passes both methods, real peer uploads, renewal, linking, restart persistence
and fresh consent. It uses disposable signatures and an owned website session
on loopback; physical devices and actual owner authentication remain separate
acceptance gates under P06/P12. The deployed `8f482b4` pilot offers Nostr sign-in
and preserves the private durable ledger. Integrating websites supply their own
authenticated account resolver; none is configured on this pilot.

The account service records cumulative media payload reservations. Every
participating device uses the same service and durable ledger. The browser's
local allowance continues to apply as well. These limits exclude signalling,
connection overhead and other HTTP traffic; they are not wire-traffic meters.

## Enabling the service

The standalone demo accepts `--account-budget-state FILE`. Its parent directory
must be private, owned by the service user and free of symlinks. The ledger is a
0600 file on a supported local POSIX filesystem, protected by an exclusive
writer lease. Preserve it and its lease files during upgrades and backups.
Keep account state outside the source checkout. The default
`account-budget.json` name and its sidecars are excluded from Git, package and
container contexts; a custom filename needs equivalent protection.

The broadcaster accepts `--account-budget` and uses
`account-budget.json` inside its existing private state directory. The Compose
template offers the service with `ACCOUNT_BUDGET_ENABLED=1`; set that value to
`0` to omit it. Offering the service does not connect a viewer's identity or
enable uploading or reporting.

The CLI supplies optional Nostr authentication. A website integrating the
server supplies its own authenticated account resolver:

```js
await startDemoServer({
  // Existing publisher and HTTPS configuration goes here.
  accountBudget: {
    statePath: '/private/relayswarm/account-budget.json',
    async resolveWebsiteAccount(request, { signal }) {
      const session = await yourAuthentication.requireSession(request, { signal });
      return { issuer: 'your-website', subject: session.userId };
    },
  },
});
```

`yourAuthentication` represents the host's existing session authentication.
Derive the subject from verified authentication. A submitted account ID,
request header chosen by the viewer, operator token or displayed public key
does not establish that authority. No account-registration system is supplied.
Both identity methods use the same reservation implementation; the website
method appears only when the host configures it.

## Connecting and linking identities

The viewer explicitly chooses a connection method. Nostr uses the browser
signer's `getPublicKey` and `signEvent` capabilities from
[NIP-07](https://github.com/nostr-protocol/nips/blob/master/07.md). Private keys
stay with the signer. Website authentication uses the host's existing signed-in
session. Neither connection enables uploading. Each new page still requires
fresh upload consent.

A connection obtains a short-lived opaque grant bound to that page's separate
ephemeral key. Renewal remains inside the original account-authorised
delegation deadline. It cannot raise the limit, reset spent bytes or extend that
deadline. Website renewal checks the current authenticated website account.
Authentication proofs use a private, versioned contract; they are not NIP-98
HTTP-auth events and are never broadcast to Nostr relays.

Different unlinked identities have separate allowances. Linking a Nostr identity
and a website account requires fresh proof of both and an explicit linking
action. Their recorded spend is added and the lower limit is retained. Existing
grants are revoked; uploading requires a fresh Apply action. Connecting another
device or reconnecting after a reload reads the existing balance.

The initial account allowance is 100 MB unless the host chooses another
supported default. Raising its limit or resetting recorded spend requires a
separate explicit action with fresh account authentication. Local allowance
settings are not copied over an existing account balance on sign-in.
The two shared-limit buttons both apply the selected limit; the reset button
also clears recorded shared usage.

## Reservation and failure behaviour

Before sending media, the client reserves its full payload against both local
and account allowances. The server serialises concurrent devices, checks the
grant and remaining allowance, and durably commits the charge before returning
acceptance. Repeating the exact same reservation operation does not charge it
again; reusing its operation ID for a different amount is refused.

An accepted or ambiguous reservation remains charged after cancellation,
disconnect or crash. There are no automatic refunds, retries or allowance
resets. A failure between the local and remote reservations can therefore
consume allowance without uploading. A connected account's unavailable or
expired authority stops contribution; it never silently substitutes a fresh
local-only allowance. Receiving can continue through the normal origin loader.

Disconnecting explicitly clears upload consent, leaves recorded spend intact
and keeps the page's requirement for account authority. Reconnecting is required
before that page can contribute again. Account and replay-record capacity limits refuse new work rather than
discarding spent counters to make room. Preserve the ledger: deleting it
discards the service's record of account expenditure. Independent deployments
with separate ledgers do not enforce one shared limit.

Grant expiry uses wall time and monotonic time while the service runs. Observed
wall-clock rollback fails closed; orderly shutdown persists the highest
observed time. After restart the service trusts the host's UTC clock and that
durable high-water mark. It cannot establish physical elapsed time during an
unobserved crash or clock change. Recorded spend persists independently of
grant expiry. Use a reliable host clock and preserve the private state.

## Privacy and scope

The account service necessarily learns which devices connect to the same
identity, and an explicit link reveals that the two identities belong together.
Its private ledger uses service-scoped pseudonyms. Protect that state and its
pseudonymisation secret as account data.

Account subjects, stable Nostr identities and grants stay out of public
admission tickets, relay events, SDP, peer messages, downloaded player receipts
and opt-in operational reports. Swarm identity remains ephemeral. Reporting
still requires its separate opt-in.

This is a cooperative payload allowance for clients using the account service.
It does not identify unique people or impose an operating-system-wide limit on
other browsers, applications or unrelated services. Physical device, sustained
operation and release acceptance remain separate gates.
