import type { RouteRecordRaw } from "vue-router";

export const routes: RouteRecordRaw[] = [
  {
    path: "/",
    name: "main",
    component: () => import("../pages/MainPage.vue"),
  },
  {
    path: "/mapping-editor",
    name: "mapping-editor",
    component: () => import("../pages/MappingEditorPage.vue"),
  },
  {
    path: "/rule-editor",
    name: "rule-editor",
    component: () => import("../pages/RuleEditorPage.vue"),
  },
];
