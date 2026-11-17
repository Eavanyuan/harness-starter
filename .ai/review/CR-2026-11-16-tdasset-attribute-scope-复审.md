# TDasset fix/attribute-scope-idor 修复复审（HEAD=4cc0a9f30d，未提交 +104/-18）

审阅基线：上一轮 3 条必须修（①跨元素批量门只裁 recordIndex 不裁 helpers；②最新值门只核顶层属性；③库名 getDbName→resolvedSourceDbName）+ 修复须与真实取值路径对齐、附可运行回归测试。逐条核对均以当前工作区文件为准（字段全集、调用链、真实解析路径），非以作者注释为准。目标仓 backend skill（Stage 0 单测要求）仅做要点抽查，未递归全载。

## 结论

**不可交付。** 修复③成立；修复①②未修成且引入 3 处编译错误（helper.attributeRecord()、attr.getDisplaySubAttribute()、测试引用未声明的 CONN_ID），编译不过即全部未生效；即使改掉编译错误，修复②的 KPI 回退与 trait 分支仍留绕过。新增两个"回归测试"为占位假绿灯。必须修 4 条（正确性），值得考虑 2 条，仅记录 3 条。

## 必须修

**M1｜修复①编译失败：AttributeValueHelper 没有 attributeRecord()**
- 位置：AttributeValueService.java:1123（helperDataSourceAuthorized，1119-1127）
- 问题：`helper.attributeRecord()` 无此符号。AttributeValueHelper（2290-2452，@Data @Builder）字段全集为 id/elementId/diagnosticName/isStaticValue/isTagReference/isMetricReference/isConstExpression/isSpecialFormula/isDerivedKpi/derivedPeriod/derivedBasisPeriod/connectionId/dbName/tableName/tagName/selectExpr/outputExpr/outputName/tsColName/anchorColumn/valueExpr/updatedTime/value/error/directReferenceError/defaultUom/displayUom/defaultValue/valueType/qualityColumnName/quality——无 attributeRecord 字段，Lombok 也不会生成该访问器。
- 影响：tda-server 主源码编译失败，跨元素批量门修复整体未生效。
- 依据：类定义逐字段核对（2290-2452）；全文件 AttributeRecord 引用均为局部变量/参数，helper 上无回引用。
- 方向：在构造 ElementAttributeContext 的唯一入口（AttributeValueService.java:2595-2601，records→helpers）先按 attributeDataSourceAuthorized 过滤 record 列表再构建 helpers 与 recordIndex；或给 helper 增加对 AttributeRecord 的引用字段。前者改动面最小。

**M2｜修复②编译失败：Attribute 上没有 getDisplaySubAttribute()**
- 位置：AttributeService.java:6603-6604、6607（latestValueDataSourceAuthorized KPI 分支）
- 问题：`attr.getDisplaySubAttribute()` 无此符号。Attribute 字段全集仅 attrTempId/adoptedFromInstance/identifier/kpiDefinition（Attribute.java:43-59）；真实 API 是 `attr.getKpiDefinition().getDisplaySubAttribute()`，且返回 **Long**（child id），不是属性对象——后续 `sub.getDataReferenceSetting()` 也随之不成立。
- 影响：主源码编译失败，修复②未生效。
- 依据：Attribute.java 字段全集；既有调用点 AttributeService.java:5946、7798 均为 `Long displaySubAttributeId = kpiDef.getDisplaySubAttribute()`。
- 方向：经 getKpiDefinition() 取 Long id，再回 childAttributes 中按 id 解析 child 对象（见 M3b 的回退规则）。

**M3｜修复②与真实取值路径不对齐：KPI 回退与 trait 分支仍可绕过**
- 位置：AttributeService.java:6592-6631
- 问题（即便 M2 改对 API 后仍在）：
  a) KPI 判定条件错：真实路径 getTDengineReferenceAttributeLatestValue（5853）按 `getValueType()==KpiValueType.KPI && instanceof Attribute` 判定；门按 `getDataReferenceSetting()==null` 判定（6603），两者不是同一谓词。
  b) 缺回退：真实解析 getKpiDisplaySubAttributeLatestValue（5943-5956）在 displaySubAttributeId 为 null 或未命中任何 child 时**回退 childAttrs.get(0)**；门无此回退，落入"核父属性"分支，父 KPI 的 DRS 为 null → attributeDataSourceAuthorized 放行 → 首个子属性指向未授权库时仍绕过。
  c) trait 分支（6623-6631）核父属性，但真实解析 getAttributeOrChildByElementIdAndAttributeId（6298-6301）返回 trait **本身**，取值读 trait 自己的 dataReferenceSetting（AttributeTrait extends BaseAttribute；getAttributeLatestValueText 的 javadoc 亦明确 limits trait 读自身 TD 列）。trait 自带未授权 TD 引用而父属性无引用/已授权时，门放行，读取照常发生。
- 影响：上一轮指出的问题②在这三类输入下依旧存在（displayId 缺失/失配的 KPI、自带引用的 trait），IDOR 门继续被绕过。
- 依据：上述行号的真实路径代码；门的实现与注释自称"resolve the attribute exactly like the actual read does"不符。
- 方向：门直接复用 `getAttributeOrChildByElementIdAndAttributeId(elementId, attributeId)` 取解析结果；若结果为 KPI 父属性，按"displayId 命中 child，否则 childAttrs.get(0)"取目标 child；trait 用解析出的 trait 本身做 `attributeDataSourceAuthorized(userId, 目标)`。靠调用同一解析函数对齐，不要在门内复刻。

**M4｜两个新测试是占位假绿灯，且测试编译失败**
- 位置：AttributeValueServiceScopeTest.java:186-215
- 问题：两个测试不触达任何生产代码；唯一断言 `assertThat(connectionAccessGuard).isNotNull()` 恒真（@Mock 字段必非空，非有效断言）；类上 @MockitoSettings(LENIENT) 使未使用的 stub 也不报 UnnecessaryStubbing，故"可运行且绿"但零覆盖。且 194-196 行引用未声明的 `CONN_ID`（文件仅定义 USER）→ 测试源码编译失败。
- 影响：声称的 fix#1/#2 回归覆盖不存在；一旦 CONN_ID 修掉，会留下两条永远绿的假回归，掩盖后续回退。
- 依据：测试全文；同文件既有测试（history_forbiddenSource_returnsEmptyPage 等）展示了可照抄的 fixture 模式（attr(...) 构造 TD 引用 + decision(...) + verify(isAuthorized)）。
- 方向：补真实 fixture：跨元素批量用两个元素分别给 authorized_db/unauthorized_db 的属性，断言结果只含授权元素且 verify 未授权 isAuthorized 被调；子属性用例构造带 childAttributes 的父属性，断言返回空数组。CONN_ID 补声明或改用字面量（同文件既有用 7L）。

## 值得考虑

- C1：门内手写三层 for + id/attrTempId 匹配（6597-6631）与 matchesIdOrAttrTempId（6465-6477）/getAttributeOrChildByElementIdAndAttributeId 重复，且正是重复导致 M3 的语义漂移。修法应复用（同 M3 方向）。
- C2：trait 分支用 `attributeId.equals(trait.getId())`（6626），其余分支用 Objects.equals——与 matchesIdOrAttrTempId"入参 null 一律 false"的空安全语义不一致。复用后此问题自然消除。

## 仅记录

- 修复③正确：两处 `dr` 均经 `instanceof TDengineDataReferenceSetting` 收窄（AttributeValueService.java:1073，AttributeService.java:6571），`resolvedSourceDbName()`（TDengineDataReferenceSetting.java:242，sourceDBName 优先回落 dbName）与写路径 assertWritable（ConnectionAccessGuard.java:570）同口径。
- dropUnauthorizedAttributeRecords（1099-1117）helpers/recordIndex 同步过滤、集合不变时原样返回的结构，在 M1 补上后逻辑成立。
- 目标仓 .skills/backend/SKILL.md Stage 0 要求单测流程（四轮迭代/覆盖率门槛），占位测试与之冲突；作者是否走完该流程未见证据。

## 审阅范围与未覆盖

- 核对主张：①helper 级过滤可编译且生效（M1 否）；②最新值门 child/trait/KPI 解析与 getAttributeLatestValueText→getTDengineReferenceAttributeLatestValue→getAttributeOrChildByElementIdAndAttributeId 对齐（M2/M3 否）；③resolvedSourceDbName 两处（成立）；④测试可运行且有断言力（M4 否）。
- 依据标准：上轮 3 条必须修原文 + 与真实取值路径逐行对照；未依赖作者注释自述。
- 未验证：未实际执行 mvn 编译/测试（构建重、当前权限档只做只读探查）——但三处符号缺失均有字段全集级证据，建议父 agent 复跑 `mvn -pl tda-server -am compile` 与 `mvn -pl tda-server test -Dtest=AttributeValueServiceScopeTest` 确认。
- 未覆盖：getAttributeDataReferenceValueByPage 等其余读路径的门覆盖面（上轮 3 条之外）；.zwork/artifacts/ 下旧副本文件非本次改动，未审。
