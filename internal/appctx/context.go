package appctx

import "context"

type contextKey string

const appKey contextKey = "app"

type App struct {
	Config interface{}
	Auth   interface{}
	SDK    interface{}
	Output interface{}
	Flags  map[string]interface{}
}

func WithContext(ctx context.Context, app *App) context.Context {
	return context.WithValue(ctx, appKey, app)
}

func FromContext(ctx context.Context) *App {
	if app, ok := ctx.Value(appKey).(*App); ok {
		return app
	}
	return nil
}
