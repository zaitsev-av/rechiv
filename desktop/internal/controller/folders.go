package controller

import (
	"errors"
	"time"

	"rechiv/desktop/internal/domain"
	"rechiv/desktop/internal/store"
)

func (c *Controller) SetFolderSettings(id string, settings domain.FolderSettings) (domain.Folder, error) {
	c.retentionMu.Lock()
	defer c.retentionMu.Unlock()
	folder, err := c.store.SetFolderSettings(id, settings)
	if err != nil {
		return domain.Folder{}, err
	}
	c.runRetentionLocked(id)
	return folder, nil
}

func (c *Controller) PreviewFolderRetention(id string, days int) ([]string, error) {
	return c.store.PreviewFolderRetention(id, days, c.now())
}

func (c *Controller) RunRetention(folderID string) {
	c.retentionMu.Lock()
	defer c.retentionMu.Unlock()
	c.runRetentionLocked(folderID)
}

func (c *Controller) runRetentionLocked(folderID string) {
	deleted := 0
	now := c.now()
	for _, folder := range c.store.Folders() {
		if folderID != "" && folder.ID != folderID {
			continue
		}
		ids, err := c.store.PreviewFolderRetention(folder.ID, folder.Settings.RetentionDays, now)
		if err != nil {
			c.logger.Printf("folder retention: %v", err)
			continue
		}
		for _, id := range ids {
			if c.ctx.Err() != nil {
				return
			}
			if err := c.DeleteSession(id); err != nil {
				if !errors.Is(err, store.ErrNotFound) {
					c.logger.Printf("folder retention delete %s: %v", id, err)
				}
			} else {
				deleted++
			}
		}
	}
	if deleted > 0 {
		c.logger.Printf("folder retention: deleted=%d", deleted)
	}
}

func (c *Controller) retentionLoop(ticks <-chan time.Time) {
	for {
		select {
		case <-c.ctx.Done():
			return
		case <-ticks:
			c.RunRetention("")
		}
	}
}
