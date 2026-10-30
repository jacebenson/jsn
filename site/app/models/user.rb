require 'openssl'
class User < ApplicationRecord
  ITERATIONS = 600_000
  has_many :login_sessions, dependent: :destroy
  attr_accessor :password
  normalizes :email, with: ->(email) { email.strip.downcase }
  validates :email, presence: true, uniqueness: true, format: { with: URI::MailTo::EMAIL_REGEXP }
  validates :password, length: { minimum: 8, maximum: 128 }, if: -> { new_record? || password.present? }
  before_save :hash_password, if: -> { password.present? }

  def authenticate(value)
    return false unless value.is_a?(String) && value.bytesize <= 512
    iterations, salt, expected = password_digest.split('$')
    actual = OpenSSL::PKCS5.pbkdf2_hmac(value, salt, iterations.to_i, 32, 'sha256').unpack1('H*')
    ActiveSupport::SecurityUtils.secure_compare(actual, expected) && self
  end

  private
  def hash_password
    salt = SecureRandom.hex(16)
    digest = OpenSSL::PKCS5.pbkdf2_hmac(password, salt, ITERATIONS, 32, 'sha256').unpack1('H*')
    self.password_digest = [ITERATIONS, salt, digest].join('$')
  end
end
