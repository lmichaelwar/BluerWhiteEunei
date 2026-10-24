import test from 'node:test';
import assert from 'node:assert/strict';
import { connectionStatus } from '../../web/status.mjs';

test('viewer separates local limits, plan quota, authorization and live inference', () => {
  assert.equal(connectionStatus({available:true,model:'gpt-6-luna',verified_inference:true}), 'Luna connected · live dialogue');
  assert.equal(connectionStatus({available:false,status:'local_limit',code:'local_hour_budget',retry_after:1729}), 'Office hourly limit · rule-based behavior · resumes in 29 min');
  assert.match(connectionStatus({status:'local_limit',code:'local_scene_pacing',retry_after:20}), /^Office pacing/);
  assert.match(connectionStatus({status:'quota',code:'usage_limit'}), /^ChatGPT plan quota paused/);
  assert.match(connectionStatus({status:'auth_required'}), /^Sign in/);
  assert.match(connectionStatus({}), /^Luna unavailable/);
});
