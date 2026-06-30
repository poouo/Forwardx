package main

type exitEndpoint struct {
	Host string `json:"host"`
	Port int    `json:"port"`
	Key  string `json:"key,omitempty"`
}

type config struct {
	Role                     string         `json:"role"`
	TunnelID                 int            `json:"tunnelId"`
	RuleID                   int            `json:"ruleId"`
	ListenPort               int            `json:"listenPort"`
	Protocol                 string         `json:"protocol"`
	ExitHost                 string         `json:"exitHost"`
	ExitPort                 int            `json:"exitPort"`
	Exits                    []exitEndpoint `json:"exits,omitempty"`
	TargetIP                 string         `json:"targetIp"`
	TargetPort               int            `json:"targetPort"`
	Key                      string         `json:"key"`
	LimitIn                  int64          `json:"limitIn"`
	LimitOut                 int64          `json:"limitOut"`
	MaxConnections           int            `json:"maxConnections"`
	MaxIPs                   int            `json:"maxIPs"`
	AccessScope              string         `json:"accessScope"`
	BlockHTTP                bool           `json:"blockHttp"`
	BlockSocks               bool           `json:"blockSocks"`
	BlockTLS                 bool           `json:"blockTls"`
	ProxyProtocolReceive     bool           `json:"proxyProtocolReceive"`
	ProxyProtocolSend        bool           `json:"proxyProtocolSend"`
	ProxyProtocolExitReceive bool           `json:"proxyProtocolExitReceive"`
	ProxyProtocolExitSend    bool           `json:"proxyProtocolExitSend"`
	ProxyProtocolVersion     int            `json:"proxyProtocolVersion"`
	TCPFastOpen              bool           `json:"tcpFastOpen"`
	PanelURL                 string         `json:"panelUrl"`
	Token                    string         `json:"token"`
	RelayExitHost            string         `json:"relayExitHost,omitempty"`
	RelayExitPort            int            `json:"relayExitPort,omitempty"`
	RelayKey                 string         `json:"relayKey,omitempty"`
	DNSGeneration            int            `json:"dnsGeneration,omitempty"`
}
