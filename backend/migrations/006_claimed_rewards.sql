-- Add claimed_rewards column to profiles to prevent cross-device re-claiming
ALTER TABLE profiles ADD COLUMN IF NOT EXISTS claimed_rewards TEXT[] DEFAULT '{}';
