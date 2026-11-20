# 企业阶段发布工具回归

当前本地运行 test_update_policy.py（12）、test_android_host.py（9）、test_release_readiness.py（10）、test_collect.py（3）、test_native_host.py（2），共36项全部通过。测试使用本地正反例/夹具，没有发布、配置生产key、创建凭据或实际核验线上策略。日志中的online/healthy是测试夹具结果，不是生产健康证明。
