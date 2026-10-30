class AccountsController < BrowserController
  rate_limit to: 10, within: 5.minutes, only: [:login], store: ActiveSupport::Cache::MemoryStore.new,
    with: -> { render plain: 'Too many attempts. Please try again in five minutes.', status: :too_many_requests }
  def login_form; end
  def login
    user = User.find_by(email: params[:email].to_s.strip.downcase)
    # Perform the same expensive password work for unknown accounts.
    candidate = user || User.new(password_digest: "#{User::ITERATIONS}$#{'0' * 32}$#{'0' * 64}")
    authenticated = candidate.authenticate(params[:password])
    if user && authenticated
      sign_in(user)
      redirect_to account_path
    else
      @error = 'Email or password is incorrect.'
      render :login_form, status: :unprocessable_entity
    end
  end
  def show
    return unless require_login
  end
  def destroy
    current_login&.destroy!
    reset_session
    redirect_to root_path
  end
end
