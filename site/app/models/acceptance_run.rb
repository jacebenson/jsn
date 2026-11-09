class AcceptanceRun < ApplicationRecord
  has_many :acceptance_checks, dependent: :delete_all
end
