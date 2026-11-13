package svnview

import (
	"encoding/xml"
	"fmt"
	"path/filepath"
	"strings"
)

type svnInfoXML struct {
	XMLName xml.Name `xml:"info"`
	Entry   struct {
		Kind       string `xml:"kind,attr"`
		Path       string `xml:"path,attr"`
		Revision   string `xml:"revision,attr"`
		URL        string `xml:"url"`
		Repository struct {
			Root string `xml:"root"`
		} `xml:"repository"`
		WCInfo struct {
			WCRootAbsPath string `xml:"wcroot-abspath"`
		} `xml:"wc-info"`
	} `xml:"entry"`
}

func parseInfoXML(data []byte, fallbackRoot string) (Info, error) {
	var parsed svnInfoXML
	if err := xml.Unmarshal(data, &parsed); err != nil {
		return Info{}, fmt.Errorf("parse svn info xml: %w", err)
	}
	revision := strings.TrimSpace(parsed.Entry.Revision)
	if revision == "" {
		return Info{}, fmt.Errorf("svn info xml missing revision")
	}
	wcRoot := strings.TrimSpace(parsed.Entry.WCInfo.WCRootAbsPath)
	if wcRoot == "" {
		wcRoot = fallbackRoot
	}
	return Info{
		WCRoot:   filepath.Clean(wcRoot),
		Revision: revision,
		URL:      strings.TrimSpace(parsed.Entry.URL),
		RepoRoot: strings.TrimSpace(parsed.Entry.Repository.Root),
	}, nil
}

type svnStatusXML struct {
	XMLName xml.Name `xml:"status"`
	Targets []struct {
		Path    string `xml:"path,attr"`
		Entries []struct {
			Path     string `xml:"path,attr"`
			Kind     string `xml:"kind,attr"`
			WCStatus struct {
				Item           string `xml:"item,attr"`
				Props          string `xml:"props,attr"`
				Revision       string `xml:"revision,attr"`
				TreeConflicted string `xml:"tree-conflicted,attr"`
				MovedFrom      string `xml:"moved-from,attr"`
				MovedTo        string `xml:"moved-to,attr"`
			} `xml:"wc-status"`
		} `xml:"entry"`
	} `xml:"target"`
}

type svnStatusEntry struct {
	Path           string
	Kind           string
	Item           string
	Props          string
	Revision       string
	TreeConflicted bool
	MovedFrom      string
	MovedTo        string
}

func parseStatusXML(data []byte) ([]svnStatusEntry, error) {
	var parsed svnStatusXML
	if err := xml.Unmarshal(data, &parsed); err != nil {
		return nil, fmt.Errorf("parse svn status xml: %w", err)
	}
	entries := make([]svnStatusEntry, 0)
	for _, target := range parsed.Targets {
		for _, entry := range target.Entries {
			entries = append(entries, svnStatusEntry{
				Path:           strings.TrimSpace(entry.Path),
				Kind:           strings.TrimSpace(entry.Kind),
				Item:           strings.TrimSpace(entry.WCStatus.Item),
				Props:          strings.TrimSpace(entry.WCStatus.Props),
				Revision:       strings.TrimSpace(entry.WCStatus.Revision),
				TreeConflicted: strings.EqualFold(strings.TrimSpace(entry.WCStatus.TreeConflicted), "true"),
				MovedFrom:      strings.TrimSpace(entry.WCStatus.MovedFrom),
				MovedTo:        strings.TrimSpace(entry.WCStatus.MovedTo),
			})
		}
	}
	return entries, nil
}

type svnLogXML struct {
	XMLName xml.Name `xml:"log"`
	Entries []struct {
		Revision string `xml:"revision,attr"`
	} `xml:"logentry"`
}

func parseLogXML(data []byte) ([]string, error) {
	var parsed svnLogXML
	if err := xml.Unmarshal(data, &parsed); err != nil {
		return nil, fmt.Errorf("parse svn log xml: %w", err)
	}
	revisions := make([]string, 0, len(parsed.Entries))
	for _, entry := range parsed.Entries {
		revision := strings.TrimSpace(entry.Revision)
		if revision != "" {
			revisions = append(revisions, revision)
		}
	}
	return revisions, nil
}
