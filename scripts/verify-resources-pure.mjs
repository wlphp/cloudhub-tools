 import { resourceColumns, listResourceViews, PREFERRED_RESOURCE_COLUMNS } from "../src/features/resources/pure.ts";
 
 const cases = [
   { items: [{ InstanceName: "x", InstanceId: "i", Status: "Running" }], expectFirst: "InstanceName" },
   { items: [{ Name: "x", BucketName: "b", IpAddress: "1.2.3.4" }], expectFirst: "Name" },
   { items: [{ Foo: 1, Bar: 2 }], expectFirst: "Foo" },
   { items: [{ _Internal: 1, InstanceName: "x" }], expectFirst: "InstanceName" },
 ];
 
 let ok = true;
 for (const c of cases) {
   const cols = resourceColumns(c.items);
   if (!cols.includes(c.expectFirst)) {
     console.error("FAIL", JSON.stringify(c), "got", cols);
     ok = false;
   } else {
     console.log("ok", JSON.stringify(c.items), "->", cols);
   }
 }
 
 const views = listResourceViews();
 const expectedViews = ["ecs", "domain", "oss", "rds", "redis", "swas", "esa"];
 if (JSON.stringify(views) !== JSON.stringify(expectedViews)) {
   console.error("FAIL views got", views);
   ok = false;
 } else {
   console.log("ok views ->", views);
 }
 
 if (PREFERRED_RESOURCE_COLUMNS.length !== 18) {
   console.error("FAIL preferred count", PREFERRED_RESOURCE_COLUMNS.length);
   ok = false;
 } else {
   console.log("ok preferred count =", PREFERRED_RESOURCE_COLUMNS.length);
 }
 
 process.exit(ok ? 0 : 1);
