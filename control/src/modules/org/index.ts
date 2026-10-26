import type { ModuleDef } from "../../app.ts";
import { tenantRoutes } from "./tenant.ts";
import { departmentRoutes } from "./departments.ts";
import { peopleRoutes } from "./people.ts";
import { jobRoleRoutes } from "./job-roles.ts";
import { roleIdentityRoutes } from "./role-identities.ts";
import { supportGrantRoutes } from "./support-grants.ts";

/** Org endpoints of API.md: tenant, departments, people, invite, job roles, role identities, support grants. */
const org: ModuleDef = {
  name: "org",
  routes(app, deps) {
    tenantRoutes(app, deps);
    departmentRoutes(app, deps);
    peopleRoutes(app, deps);
    jobRoleRoutes(app, deps);
    roleIdentityRoutes(app, deps);
    supportGrantRoutes(app, deps);
  },
};

export default org;
