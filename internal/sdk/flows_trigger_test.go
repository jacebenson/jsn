package sdk

import (
	"context"
	"fmt"
	"os"
	"testing"
)

// These are integration tests that require a live ServiceNow instance.
// Run with: SN_INSTANCE=https://dev373698.service-now.com SN_USER=admin SN_PASS=xxx go test -v -run TestTrigger ./internal/sdk/ -count=1

func newTestClient(t *testing.T) *Client {
	t.Helper()
	instance := os.Getenv("SN_INSTANCE")
	user := os.Getenv("SN_USER")
	pass := os.Getenv("SN_PASS")
	if instance == "" || user == "" || pass == "" {
		t.Skip("SN_INSTANCE, SN_USER, SN_PASS required")
	}
	return NewClient(instance, func() (string, string, bool) {
		return pass, user, false // basic auth: token=password, cookiesOrUsername=username
	})
}

func TestTriggerWeekly(t *testing.T) {
	c := newTestClient(t)
	err := c.CreateScheduledTrigger(context.Background(), CreateScheduledTriggerOptions{
		FlowID:   "3a7496839384cb10250bf3b9dd03d656",
		Schedule: "weekly",
		Time:     "09:30:00",
		Day:      "3", // Wednesday
	})
	if err != nil {
		t.Fatal(err)
	}
	fmt.Println("✓ Weekly trigger created")
}

func TestTriggerMonthly(t *testing.T) {
	c := newTestClient(t)
	err := c.CreateScheduledTrigger(context.Background(), CreateScheduledTriggerOptions{
		FlowID:   "3a7496839384cb10250bf3b9dd03d674",
		Schedule: "monthly",
		Time:     "14:00:00",
		Day:      "15",
	})
	if err != nil {
		t.Fatal(err)
	}
	fmt.Println("✓ Monthly trigger created")
}

func TestTriggerOnce(t *testing.T) {
	c := newTestClient(t)
	err := c.CreateScheduledTrigger(context.Background(), CreateScheduledTriggerOptions{
		FlowID:   "877496839384cb10250bf3b9dd03d6ab",
		Schedule: "once",
		Date:     "2026-06-15 10:00:00",
	})
	if err != nil {
		t.Fatal(err)
	}
	fmt.Println("✓ Once trigger created")
}
