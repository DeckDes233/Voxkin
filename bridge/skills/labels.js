// 方块 ID 与中文名的对照表。桥接用它显示中文，Core 用它解析玩家说的中文方块名，
// 两边共用这一份，避免各写一套映射后慢慢跑偏。
// 改动后跑 node scripts/dump_labels.js 重新生成 labels.json。
export const BLOCK_NAMES = {
  dirt: '泥土',
  grass_block: '草方块',
  stone: '石头',
  cobblestone: '圆石',
  oak_log: '橡木',
  birch_log: '白桦木',
  sand: '沙子',
  gravel: '沙砾',
  coal_ore: '煤矿',
  iron_ore: '铁矿',
  wheat: '小麦',
  zombie: '僵尸',
  skeleton: '骷髅',
  spider: '蜘蛛',
  creeper: '苦力怕',
  witch: '女巫',
  enderman: '末影人',
  slime: '史莱姆',
  drowned: '溺尸',
  husk: '尸壳',
  stray: '流浪者',
  phantom: '幻翼',
};

export default BLOCK_NAMES;
