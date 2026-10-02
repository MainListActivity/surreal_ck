/**
 * 已上移到 `@surreal-ck/shared/native-quota/plan-rules`：同一产品规则源同时供
 * seed 与前端建簿容量预检/真机验证使用，避免两处实现漂移。本文件保留薄壳
 * 再导出，维持既有 `server/src/db/quota-plan-rules` 导入路径。
 */
export {
  commercialProductRules,
  MAX_V2_LIMITS,
  MAX_V2_REVISION_KEY,
  SEEDED_PLAN_LIMITS,
} from "@surreal-ck/shared/native-quota";
export type { SeededPlanKey } from "@surreal-ck/shared/native-quota";
