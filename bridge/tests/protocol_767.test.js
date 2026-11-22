import assert from 'node:assert/strict';
import test from 'node:test';
import protocol from 'minecraft-protocol';
import { applyProtocol767ItemFormat } from '../protocol_767.js';

test('1.21.1 inventory keeps the slot after a potion in sync', () => {
  applyProtocol767ItemFormat();
  const options = { state: 'play', version: '1.21.1' };
  // 两格正常库存：一瓶基础药水、三颗钻石，光标为空。字节独立于待测编码器。
  const packet = Buffer.from('13 00 01 02 01 e6 07 01 00 1f 01 00 00 00 03 a5 06 00 00 00'.replaceAll(' ', ''), 'hex');
  const { data, metadata } = protocol.createDeserializer(options).parsePacketBuffer(packet);
  assert.equal(metadata.size, packet.length);
  assert.equal(data.name, 'window_items');
  assert.equal(data.params.items[0].components[0].type, 'potion_contents');
  assert.equal(data.params.items[1].itemId, 805);
  assert.equal(data.params.items[1].itemCount, 3);
  assert.deepEqual(protocol.createSerializer({ ...options, isServer: true }).createPacketBuffer(data), packet);
});
