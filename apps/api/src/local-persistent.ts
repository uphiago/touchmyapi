import { closeTenantDatabase, createTenantDatabase, withTenant } from "@touchmyapi/db";
import type { ApiConfig } from "./config";
import { createLocalDevelopmentApp } from "./local-development";
import { createPostgresAssessmentStore } from "./postgres-assessment-store";
import { createPostgresDeliveryStore } from "./postgres-delivery-store";
import { S3CompatiblePrivateReportStorage } from "@touchmyapi/reporting";

export async function createPersistentLocalDevelopmentApp(
  config: ApiConfig,
  databaseUrl: string,
): Promise<{
  app: ReturnType<typeof createLocalDevelopmentApp>;
  close: () => Promise<void>;
}> {
  const database = createTenantDatabase(databaseUrl);
  try {
    await withTenant(
      database,
      "00000000-0000-4000-8000-000000000000",
      "api_rls",
      async (context) => {
        await context.account.readCurrent();
      },
    );
    const store = createPostgresAssessmentStore(database, async () => ["93.184.216.34"]);
    const reportStorage = new S3CompatiblePrivateReportStorage({
      endpoint: "http://127.0.0.1:9000",
      bucket: "touchmyapi-reports",
      region: "auto",
      accessKeyId: "touchmyapi_dev",
      secretAccessKey: "touchmyapi_dev_change_me",
    });
    await reportStorage.ensurePrivateBucket();
    return {
      app: createLocalDevelopmentApp(config, {
        assessmentStore: store,
        deliveryStore: createPostgresDeliveryStore(database, reportStorage),
      }),
      close: () => closeTenantDatabase(database),
    };
  } catch (error) {
    await closeTenantDatabase(database);
    throw error;
  }
}
