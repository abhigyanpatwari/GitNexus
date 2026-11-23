import { describe, expect, it } from 'vitest';
import { getRelationships, useFixture } from './helpers.js';

describe('Ruby local ownership beside accessor types', () => {
  const run = useFixture('ruby-review-followups', {
    'host.rb': `class User
  def save; end
end
class Host
  # @return [User]
  attr_reader :user
  def untyped
    user = 42
    user.save
  end
  def ordered
    user.save
    user = 42
    user.save
  end
  def typed
    user = User.new
    user.save
    [1].each { user.save }
  end
  def block_local
    [1].each { user = 42; user.save }
    user.save
  end
  def rebound
    user = User.new
    user = 42
    user.save
  end
  def captured_rebound
    user = User.new
    [1].each { user = 42; user.save }
    user.save
  end
end
`,
  });
  it('keeps typed locals and accessor reads before assignment, but never lends their type to an untyped local', () => {
    expect(
      getRelationships(run(), 'CALLS')
        .filter((edge) => edge.target === 'save')
        .map((edge) => `${edge.source} -> ${edge.rel.targetId}`)
        .sort(),
    ).toEqual([
      'block_local -> Method:host.rb:User.save#0',
      'ordered -> Method:host.rb:User.save#0',
      'typed -> Method:host.rb:User.save#0',
      'typed -> Method:host.rb:User.save#0',
    ]);
  });
});
