class LoginSession < ApplicationRecord
  belongs_to :user
  def self.digest(token) = Digest::SHA256.hexdigest(token)
end
