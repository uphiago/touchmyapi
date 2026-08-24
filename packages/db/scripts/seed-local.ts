import postgres from "postgres";

const databaseUrl = process.env.DATABASE_URL;
if (!databaseUrl) {
  process.stderr.write("DATABASE_URL is required for local seed\n");
  process.exit(1);
}
if (process.env.NODE_ENV === "production") {
  process.stderr.write("local seed is forbidden in production\n");
  process.exit(1);
}

const accounts = [
  ["00000000-0000-4000-8000-000000000101", "owner", "lifetime", "301"],
  ["00000000-0000-4000-8000-000000000107", "admin", "pro", "307"],
  ["00000000-0000-4000-8000-000000000102", "operator", "free_verified", "302"],
  ["00000000-0000-4000-8000-000000000108", "viewer", "free_unverified", "308"],
  ["00000000-0000-4000-8000-000000000109", "billing", "pro", "309"],
] as const;
const userId = "00000000-0000-4000-8000-000000000103";

const db = postgres(databaseUrl, { max: 1 });
try {
  await db.begin(async (transaction) => {
    for (const [accountId] of accounts) {
      await transaction`
        insert into public.account (id, status)
        values (${accountId}::uuid, 'active'::public.account_status)
        on conflict (id) do update set status = 'active'::public.account_status,
          deleted_at = null
      `;
      await transaction`
        insert into public.audit_account_state (account_id)
        values (${accountId}::uuid)
        on conflict (account_id) do nothing
      `;
    }
    for (const [accountId, , plan, suffix] of accounts) {
      if (plan === "free_unverified") continue;
      const eventId = `00000000-0000-4000-8000-000000000${suffix}`;
      const entitlementId = `00000000-0000-4000-8000-000000000${Number(suffix) + 100}`;
      await transaction`
        insert into public.billing_event (
          id, account_id, stripe_event_id, type, payload_minimal_json,
          signature_valid, event_version, api_version, processing_status, processed_at
        ) values (
          ${eventId}::uuid, ${accountId}::uuid, ${`evt_local_${suffix}`},
          'local.seed.entitlement', ${JSON.stringify({ source: "credential-free-local-seed" })}::jsonb,
          true, 'local.seed@1', 'local', 'processed'::public.billing_processing_status,
          clock_timestamp()
        )
        on conflict (stripe_event_id) do update set
          account_id = excluded.account_id, signature_valid = true,
          processing_status = 'processed'::public.billing_processing_status,
          processed_at = clock_timestamp()
      `;
      await transaction`
        insert into public.entitlement (id, account_id, plan, status, source_event_id)
        values (
          ${entitlementId}::uuid, ${accountId}::uuid, ${plan}::public.entitlement_plan,
          'active'::public.entitlement_status, ${eventId}::uuid
        )
        on conflict (id) do update set
          plan = excluded.plan, status = 'active'::public.entitlement_status,
          source_event_id = excluded.source_event_id, expires_at = null
      `;
    }
    await transaction`
      insert into public.user (id, account_id, provider, provider_subject, email)
      values (
        ${userId}::uuid, ${accounts[0][0]}::uuid,
        'github'::public.identity_provider, 'local-development-user',
        'local.owner@example.test'::citext
      )
      on conflict (provider, provider_subject) do update set
        email = excluded.email
    `;
    for (const [accountId, role] of accounts) {
      await transaction`
        insert into public.account_membership (account_id, user_id, role, status)
        values (
          ${accountId}::uuid, ${userId}::uuid,
          ${role}::public.membership_role, 'active'::public.membership_status
        )
        on conflict (account_id, user_id) do update set
          role = excluded.role, status = 'active'::public.membership_status,
          removed_at = null, updated_at = clock_timestamp()
      `;
    }
  });
  process.stdout.write("[local-seed] persistent workspace ready\n");
} finally {
  await db.end();
}
