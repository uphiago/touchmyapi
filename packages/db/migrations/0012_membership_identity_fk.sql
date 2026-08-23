ALTER TABLE "account_invitation" DROP CONSTRAINT "account_invitation_invited_by_user_fk";
--> statement-breakpoint
ALTER TABLE "account_invitation" DROP CONSTRAINT "account_invitation_accepted_by_user_fk";
--> statement-breakpoint
ALTER TABLE "account_membership" DROP CONSTRAINT "account_membership_user_fk";
--> statement-breakpoint
ALTER TABLE "account_membership" DROP CONSTRAINT "account_membership_invited_by_user_fk";
--> statement-breakpoint
ALTER TABLE "account_invitation" ADD CONSTRAINT "account_invitation_invited_by_user_fk" FOREIGN KEY ("invited_by_user_id") REFERENCES "public"."user"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "account_invitation" ADD CONSTRAINT "account_invitation_accepted_by_user_fk" FOREIGN KEY ("accepted_by_user_id") REFERENCES "public"."user"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "account_membership" ADD CONSTRAINT "account_membership_user_fk" FOREIGN KEY ("user_id") REFERENCES "public"."user"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "account_membership" ADD CONSTRAINT "account_membership_invited_by_user_fk" FOREIGN KEY ("invited_by_user_id") REFERENCES "public"."user"("id") ON DELETE no action ON UPDATE no action;