import { createAuthClient } from "better-auth/react";
import { organizationClient, twoFactorClient, usernameClient } from "better-auth/client/plugins";
import { passkeyClient } from "@better-auth/passkey/client";
import { apiKeyClient } from "@better-auth/api-key/client";
import { ac, roles } from "./permissions";

export const authClient = createAuthClient({
  plugins: [twoFactorClient(), usernameClient(), passkeyClient(), organizationClient({ ac, roles }), apiKeyClient()],
});
