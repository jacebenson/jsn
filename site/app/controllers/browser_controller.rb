class BrowserController < ActionController::Base
  protect_from_forgery with: :exception
  layout 'application'
  helper_method :current_user
  private
  def current_login
    return @current_login if defined?(@current_login)
    @current_login = LoginSession.includes(:user).where('expires_at > ?', Time.current)
      .find_by(token_digest: LoginSession.digest(session[:login_token].to_s))
  end
  def current_user = current_login&.user
  def require_login
    redirect_to login_path unless current_user
  end
  def require_admin
    return redirect_to(login_path) unless current_user
    head :forbidden unless current_user.admin?
  end
  def sign_in(user)
    current_login&.destroy!
    reset_session
    token = SecureRandom.hex(32)
    LoginSession.where('expires_at <= ?', Time.current).delete_all
    user.login_sessions.create!(token_digest: LoginSession.digest(token), expires_at: 30.days.from_now)
    session[:login_token] = token
  end
end
