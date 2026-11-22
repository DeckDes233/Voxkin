import minecraftData from 'minecraft-data';

export function applyProtocol767ItemFormat() {
  // 1.21.1 的 PotionContents 到效果列表为止。额外读取 1.21.2 的名称会吃掉下一格的字节。
  const schema = minecraftData('1.21.1').protocol.types.SlotComponent;
  const data = schema[1].find(field => field.name === 'data');
  const fields = data.type[1].fields.potion_contents[1];
  if (fields.at(-1)?.name === 'customName') fields.pop();
}
