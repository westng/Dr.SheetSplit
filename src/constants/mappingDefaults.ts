import type { LegacyMappingData } from "../types/mapping";

export const DEFAULT_MAPPING_DATA: LegacyMappingData = {
  arrivalWarehouse: [
    { source: "上海航头生鲜加工中心", target: "上海冷藏集配RDC" },
    { source: "成都生鲜加工中心", target: "成都冷藏集配RDC" },
    { source: "广州生鲜加工中心", target: "广州冷藏集配RDC" },
    { source: "济南生鲜加工中心", target: "济南冷藏集配RDC" },
    { source: "武汉生鲜加工中心", target: "武汉冷藏集配RDC" },
  ],
  shippingWarehouse: [
    { source: "上海子公司", target: "衢州" },
    { source: "浙江子公司", target: "衢州" },
    { source: "南京子公司", target: "衢州" },
    { source: "苏南子公司", target: "衢州" },
    { source: "合肥子公司", target: "衢州" },
    { source: "宁波子公司", target: "衢州" },
    { source: "北京子公司", target: "衢州" },
    { source: "济南子公司", target: "宜昌" },
    { source: "青岛子公司", target: "宜昌" },
    { source: "广州子公司", target: "宜昌" },
    { source: "深圳子公司", target: "宜昌" },
    { source: "成都子公司", target: "宜昌" },
    { source: "重庆子公司", target: "宜昌" },
    { source: "贵州子公司", target: "宜昌" },
    { source: "昆明子公司", target: "宜昌" },
    { source: "武汉子公司", target: "宜昌" },
    { source: "西安子公司", target: "宜昌" },
    { source: "郑州子公司", target: "宜昌" },
    { source: "长沙子公司", target: "宜昌" },
    { source: "南昌子公司", target: "宜昌" },
  ],
  region: [
    { source: "成都生鲜加工中心 + 成都子公司", target: "总部-直送仓" },
    { source: "成都生鲜加工中心 + 昆明子公司", target: "总部-RDC仓" },
    { source: "成都生鲜加工中心 + 重庆子公司", target: "总部-RDC仓" },
    { source: "宁波盒马生鲜仓 + 宁波子公司", target: "宁波" },
  ],
  quantityColumn: [
    { source: "444844012", target: "采购件数（提）" },
    { source: "440692047", target: "采购件数（提）" },
  ],
};
