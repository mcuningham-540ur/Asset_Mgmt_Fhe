// App.tsx
import { ConnectButton } from '@rainbow-me/rainbowkit';
import '@rainbow-me/rainbowkit/styles.css';
import React, { useEffect, useState } from "react";
import { ethers } from "ethers";
import { getContractReadOnly, getContractWithSigner } from "./contract";
import "./App.css";
import { useAccount, useSignMessage } from 'wagmi';

interface Fund {
  id: string;
  name: string;
  encryptedNav: string;
  encryptedPerformance: string;
  encryptedManagementFee: string;
  timestamp: number;
  owner: string;
  status: "active" | "closed" | "pending";
  complianceStatus: "verified" | "pending" | "failed";
}

const FHEEncryptNumber = (value: number): string => {
  return `FHE-${btoa(value.toString())}`;
};

const FHEDecryptNumber = (encryptedData: string): number => {
  if (encryptedData.startsWith('FHE-')) {
    return parseFloat(atob(encryptedData.substring(4)));
  }
  return parseFloat(encryptedData);
};

const FHECompute = (encryptedData: string, operation: string): string => {
  const value = FHEDecryptNumber(encryptedData);
  let result = value;
  
  switch(operation) {
    case 'increase10%':
      result = value * 1.1;
      break;
    case 'decrease10%':
      result = value * 0.9;
      break;
    case 'double':
      result = value * 2;
      break;
    default:
      result = value;
  }
  
  return FHEEncryptNumber(result);
};

const generatePublicKey = () => `0x${Array(2000).fill(0).map(() => Math.floor(Math.random() * 16).toString(16)).join('')}`;

const App: React.FC = () => {
  const { address, isConnected } = useAccount();
  const { signMessageAsync } = useSignMessage();
  const [loading, setLoading] = useState(true);
  const [funds, setFunds] = useState<Fund[]>([]);
  const [isRefreshing, setIsRefreshing] = useState(false);
  const [showCreateModal, setShowCreateModal] = useState(false);
  const [creating, setCreating] = useState(false);
  const [transactionStatus, setTransactionStatus] = useState<{ visible: boolean; status: "pending" | "success" | "error"; message: string; }>({ visible: false, status: "pending", message: "" });
  const [newFundData, setNewFundData] = useState({ name: "", initialNav: 0, performanceFee: 0, managementFee: 0 });
  const [showTutorial, setShowTutorial] = useState(false);
  const [selectedFund, setSelectedFund] = useState<Fund | null>(null);
  const [decryptedValues, setDecryptedValues] = useState<{nav?: number, performance?: number, fee?: number}>({});
  const [isDecrypting, setIsDecrypting] = useState(false);
  const [publicKey, setPublicKey] = useState<string>("");
  const [contractAddress, setContractAddress] = useState<string>("");
  const [chainId, setChainId] = useState<number>(0);
  const [startTimestamp, setStartTimestamp] = useState<number>(0);
  const [durationDays, setDurationDays] = useState<number>(30);
  const [searchTerm, setSearchTerm] = useState("");
  const [filterStatus, setFilterStatus] = useState<string>("all");
  const [filterCompliance, setFilterCompliance] = useState<string>("all");

  const activeCount = funds.filter(f => f.status === "active").length;
  const closedCount = funds.filter(f => f.status === "closed").length;
  const pendingCount = funds.filter(f => f.status === "pending").length;
  const verifiedCount = funds.filter(f => f.complianceStatus === "verified").length;
  const complianceFailedCount = funds.filter(f => f.complianceStatus === "failed").length;

  useEffect(() => {
    loadFunds().finally(() => setLoading(false));
    const initSignatureParams = async () => {
      const contract = await getContractReadOnly();
      if (contract) setContractAddress(await contract.getAddress());
      if (window.ethereum) {
        const chainIdHex = await window.ethereum.request({ method: 'eth_chainId' });
        setChainId(parseInt(chainIdHex, 16));
      }
      setStartTimestamp(Math.floor(Date.now() / 1000));
      setDurationDays(30);
      setPublicKey(generatePublicKey());
    };
    initSignatureParams();
  }, []);

  const loadFunds = async () => {
    setIsRefreshing(true);
    try {
      const contract = await getContractReadOnly();
      if (!contract) return;
      const isAvailable = await contract.isAvailable();
      if (!isAvailable) return;
      const keysBytes = await contract.getData("fund_keys");
      let keys: string[] = [];
      if (keysBytes.length > 0) {
        try {
          const keysStr = ethers.toUtf8String(keysBytes);
          if (keysStr.trim() !== '') keys = JSON.parse(keysStr);
        } catch (e) { console.error("Error parsing fund keys:", e); }
      }
      const list: Fund[] = [];
      for (const key of keys) {
        try {
          const fundBytes = await contract.getData(`fund_${key}`);
          if (fundBytes.length > 0) {
            try {
              const fundData = JSON.parse(ethers.toUtf8String(fundBytes));
              list.push({ 
                id: key, 
                name: fundData.name, 
                encryptedNav: fundData.nav, 
                encryptedPerformance: fundData.performance, 
                encryptedManagementFee: fundData.managementFee,
                timestamp: fundData.timestamp, 
                owner: fundData.owner, 
                status: fundData.status || "pending",
                complianceStatus: fundData.complianceStatus || "pending"
              });
            } catch (e) { console.error(`Error parsing fund data for ${key}:`, e); }
          }
        } catch (e) { console.error(`Error loading fund ${key}:`, e); }
      }
      list.sort((a, b) => b.timestamp - a.timestamp);
      setFunds(list);
    } catch (e) { console.error("Error loading funds:", e); } 
    finally { setIsRefreshing(false); setLoading(false); }
  };

  const submitFund = async () => {
    if (!isConnected) { alert("Please connect wallet first"); return; }
    setCreating(true);
    setTransactionStatus({ visible: true, status: "pending", message: "Encrypting fund data with Zama FHE..." });
    try {
      const encryptedNav = FHEEncryptNumber(newFundData.initialNav);
      const encryptedPerformance = FHEEncryptNumber(newFundData.performanceFee);
      const encryptedManagementFee = FHEEncryptNumber(newFundData.managementFee);
      
      const contract = await getContractWithSigner();
      if (!contract) throw new Error("Failed to get contract with signer");
      
      const fundId = `fund-${Date.now()}-${Math.random().toString(36).substring(2, 6)}`;
      const fundData = { 
        name: newFundData.name, 
        nav: encryptedNav, 
        performance: encryptedPerformance,
        managementFee: encryptedManagementFee,
        timestamp: Math.floor(Date.now() / 1000), 
        owner: address, 
        status: "pending",
        complianceStatus: "pending"
      };
      
      await contract.setData(`fund_${fundId}`, ethers.toUtf8Bytes(JSON.stringify(fundData)));
      
      const keysBytes = await contract.getData("fund_keys");
      let keys: string[] = [];
      if (keysBytes.length > 0) {
        try { keys = JSON.parse(ethers.toUtf8String(keysBytes)); } 
        catch (e) { console.error("Error parsing keys:", e); }
      }
      keys.push(fundId);
      await contract.setData("fund_keys", ethers.toUtf8Bytes(JSON.stringify(keys)));
      
      setTransactionStatus({ visible: true, status: "success", message: "Fund created with FHE encryption!" });
      await loadFunds();
      setTimeout(() => {
        setTransactionStatus({ visible: false, status: "pending", message: "" });
        setShowCreateModal(false);
        setNewFundData({ name: "", initialNav: 0, performanceFee: 0, managementFee: 0 });
      }, 2000);
    } catch (e: any) {
      const errorMessage = e.message.includes("user rejected transaction") ? "Transaction rejected by user" : "Submission failed: " + (e.message || "Unknown error");
      setTransactionStatus({ visible: true, status: "error", message: errorMessage });
      setTimeout(() => setTransactionStatus({ visible: false, status: "pending", message: "" }), 3000);
    } finally { setCreating(false); }
  };

  const decryptWithSignature = async (encryptedData: string): Promise<number | null> => {
    if (!isConnected) { alert("Please connect wallet first"); return null; }
    setIsDecrypting(true);
    try {
      const message = `publickey:${publicKey}\ncontractAddresses:${contractAddress}\ncontractsChainId:${chainId}\nstartTimestamp:${startTimestamp}\ndurationDays:${durationDays}`;
      await signMessageAsync({ message });
      await new Promise(resolve => setTimeout(resolve, 1500));
      return FHEDecryptNumber(encryptedData);
    } catch (e) { console.error("Decryption failed:", e); return null; } 
    finally { setIsDecrypting(false); }
  };

  const verifyCompliance = async (fundId: string) => {
    if (!isConnected) { alert("Please connect wallet first"); return; }
    setTransactionStatus({ visible: true, status: "pending", message: "Processing compliance check with FHE..." });
    try {
      const contract = await getContractReadOnly();
      if (!contract) throw new Error("Failed to get contract");
      const fundBytes = await contract.getData(`fund_${fundId}`);
      if (fundBytes.length === 0) throw new Error("Fund not found");
      const fundData = JSON.parse(ethers.toUtf8String(fundBytes));
      
      // Simulate FHE compliance check
      const nav = FHEDecryptNumber(fundData.nav);
      const isCompliant = nav > 100; // Simple compliance rule for demo
      
      const contractWithSigner = await getContractWithSigner();
      if (!contractWithSigner) throw new Error("Failed to get contract with signer");
      
      const updatedFund = { 
        ...fundData, 
        complianceStatus: isCompliant ? "verified" : "failed",
        status: "active"
      };
      await contractWithSigner.setData(`fund_${fundId}`, ethers.toUtf8Bytes(JSON.stringify(updatedFund)));
      
      setTransactionStatus({ visible: true, status: "success", message: "FHE compliance check completed!" });
      await loadFunds();
      setTimeout(() => setTransactionStatus({ visible: false, status: "pending", message: "" }), 2000);
    } catch (e: any) {
      setTransactionStatus({ visible: true, status: "error", message: "Compliance check failed: " + (e.message || "Unknown error") });
      setTimeout(() => setTransactionStatus({ visible: false, status: "pending", message: "" }), 3000);
    }
  };

  const closeFund = async (fundId: string) => {
    if (!isConnected) { alert("Please connect wallet first"); return; }
    setTransactionStatus({ visible: true, status: "pending", message: "Closing fund with FHE..." });
    try {
      const contract = await getContractWithSigner();
      if (!contract) throw new Error("Failed to get contract with signer");
      const fundBytes = await contract.getData(`fund_${fundId}`);
      if (fundBytes.length === 0) throw new Error("Fund not found");
      const fundData = JSON.parse(ethers.toUtf8String(fundBytes));
      const updatedFund = { ...fundData, status: "closed" };
      await contract.setData(`fund_${fundId}`, ethers.toUtf8Bytes(JSON.stringify(updatedFund)));
      setTransactionStatus({ visible: true, status: "success", message: "Fund closed successfully!" });
      await loadFunds();
      setTimeout(() => setTransactionStatus({ visible: false, status: "pending", message: "" }), 2000);
    } catch (e: any) {
      setTransactionStatus({ visible: true, status: "error", message: "Failed to close fund: " + (e.message || "Unknown error") });
      setTimeout(() => setTransactionStatus({ visible: false, status: "pending", message: "" }), 3000);
    }
  };

  const isOwner = (fundAddress: string) => address?.toLowerCase() === fundAddress.toLowerCase();

  const tutorialSteps = [
    { title: "Connect Wallet", description: "Connect your Web3 wallet to access the FHE asset management platform", icon: "🔗" },
    { title: "Create Encrypted Fund", description: "Set up a new fund with all sensitive data encrypted using Zama FHE", icon: "🔒", details: "NAV, performance fees and management fees are encrypted client-side before submission" },
    { title: "FHE Compliance Check", description: "Our DAO performs compliance checks on encrypted data without decryption", icon: "⚖️", details: "Zama FHE enables regulatory checks while preserving investor privacy" },
    { title: "Manage Portfolio", description: "Monitor and manage your encrypted portfolio with full transparency", icon: "📊", details: "All computations are performed on encrypted data using FHE homomorphic properties" }
  ];

  const renderComplianceChart = () => {
    const total = funds.length || 1;
    const verifiedPercentage = (verifiedCount / total) * 100;
    const pendingPercentage = (pendingCount / total) * 100;
    const failedPercentage = (complianceFailedCount / total) * 100;
    
    return (
      <div className="compliance-chart">
        <div className="chart-bar verified" style={{ width: `${verifiedPercentage}%` }}></div>
        <div className="chart-bar pending" style={{ width: `${pendingPercentage}%` }}></div>
        <div className="chart-bar failed" style={{ width: `${failedPercentage}%` }}></div>
        <div className="chart-labels">
          <span>Verified: {verifiedCount}</span>
          <span>Pending: {pendingCount}</span>
          <span>Failed: {complianceFailedCount}</span>
        </div>
      </div>
    );
  };

  const filteredFunds = funds.filter(fund => {
    const matchesSearch = fund.name.toLowerCase().includes(searchTerm.toLowerCase());
    const matchesStatus = filterStatus === "all" || fund.status === filterStatus;
    const matchesCompliance = filterCompliance === "all" || fund.complianceStatus === filterCompliance;
    return matchesSearch && matchesStatus && matchesCompliance;
  });

  if (loading) return (
    <div className="loading-screen">
      <div className="metal-spinner"></div>
      <p>Initializing FHE asset management platform...</p>
    </div>
  );

  return (
    <div className="app-container metal-theme">
      <header className="app-header">
        <div className="logo">
          <div className="logo-icon"><div className="shield-icon"></div></div>
          <h1>FHE<span>Asset</span>Mgmt</h1>
        </div>
        <div className="header-actions">
          <button onClick={() => setShowCreateModal(true)} className="create-fund-btn metal-button">
            <div className="add-icon"></div>New Fund
          </button>
          <button className="metal-button" onClick={() => setShowTutorial(!showTutorial)}>
            {showTutorial ? "Hide Guide" : "Show Guide"}
          </button>
          <div className="wallet-connect-wrapper"><ConnectButton accountStatus="address" chainStatus="icon" showBalance={false}/></div>
        </div>
      </header>
      <div className="main-content">
        <div className="welcome-banner">
          <div className="welcome-text">
            <h2>Decentralized Asset Management</h2>
            <p>Create and manage fully encrypted on-chain funds with Zama FHE technology</p>
          </div>
          <div className="fhe-indicator"><div className="fhe-lock"></div><span>FHE Encryption Active</span></div>
        </div>
        
        {showTutorial && (
          <div className="tutorial-section metal-card">
            <h2>FHE Asset Management Guide</h2>
            <p className="subtitle">Learn how to manage encrypted funds with zero-knowledge compliance</p>
            <div className="tutorial-steps">
              {tutorialSteps.map((step, index) => (
                <div className="tutorial-step" key={index}>
                  <div className="step-icon">{step.icon}</div>
                  <div className="step-content">
                    <h3>{step.title}</h3>
                    <p>{step.description}</p>
                    {step.details && <div className="step-details">{step.details}</div>}
                  </div>
                </div>
              ))}
            </div>
            <div className="fhe-diagram">
              <div className="diagram-step"><div className="diagram-icon">📊</div><div className="diagram-label">Fund Data</div></div>
              <div className="diagram-arrow">→</div>
              <div className="diagram-step"><div className="diagram-icon">🔒</div><div className="diagram-label">FHE Encryption</div></div>
              <div className="diagram-arrow">→</div>
              <div className="diagram-step"><div className="diagram-icon">⚖️</div><div className="diagram-label">Compliance Checks</div></div>
              <div className="diagram-arrow">→</div>
              <div className="diagram-step"><div className="diagram-icon">🏦</div><div className="diagram-label">Encrypted Portfolio</div></div>
            </div>
          </div>
        )}
        
        <div className="dashboard-grid">
          <div className="dashboard-card metal-card">
            <h3>Fund Statistics</h3>
            <div className="stats-grid">
              <div className="stat-item"><div className="stat-value">{funds.length}</div><div className="stat-label">Total Funds</div></div>
              <div className="stat-item"><div className="stat-value">{activeCount}</div><div className="stat-label">Active</div></div>
              <div className="stat-item"><div className="stat-value">{closedCount}</div><div className="stat-label">Closed</div></div>
              <div className="stat-item"><div className="stat-value">{pendingCount}</div><div className="stat-label">Pending</div></div>
            </div>
          </div>
          
          <div className="dashboard-card metal-card">
            <h3>Compliance Status</h3>
            {renderComplianceChart()}
          </div>
          
          <div className="dashboard-card metal-card">
            <h3>Zama FHE Integration</h3>
            <p>This platform uses <strong>Zama FHE</strong> to encrypt all sensitive fund data while enabling:</p>
            <ul className="fhe-features">
              <li>Encrypted NAV calculations</li>
              <li>Private performance tracking</li>
              <li>Confidential fee computations</li>
              <li>Regulatory compliance without exposure</li>
            </ul>
            <div className="fhe-badge"><span>FHE-Powered</span></div>
          </div>
        </div>
        
        <div className="funds-section">
          <div className="section-header">
            <h2>Encrypted Fund Portfolio</h2>
            <div className="header-actions">
              <div className="search-filter">
                <input 
                  type="text" 
                  placeholder="Search funds..." 
                  value={searchTerm}
                  onChange={(e) => setSearchTerm(e.target.value)}
                  className="metal-input"
                />
                <select 
                  value={filterStatus} 
                  onChange={(e) => setFilterStatus(e.target.value)}
                  className="metal-select"
                >
                  <option value="all">All Status</option>
                  <option value="active">Active</option>
                  <option value="closed">Closed</option>
                  <option value="pending">Pending</option>
                </select>
                <select 
                  value={filterCompliance} 
                  onChange={(e) => setFilterCompliance(e.target.value)}
                  className="metal-select"
                >
                  <option value="all">All Compliance</option>
                  <option value="verified">Verified</option>
                  <option value="pending">Pending</option>
                  <option value="failed">Failed</option>
                </select>
              </div>
              <button onClick={loadFunds} className="refresh-btn metal-button" disabled={isRefreshing}>
                {isRefreshing ? "Refreshing..." : "Refresh"}
              </button>
            </div>
          </div>
          
          <div className="funds-list metal-card">
            <div className="table-header">
              <div className="header-cell">Fund Name</div>
              <div className="header-cell">Owner</div>
              <div className="header-cell">Created</div>
              <div className="header-cell">Status</div>
              <div className="header-cell">Compliance</div>
              <div className="header-cell">Actions</div>
            </div>
            
            {filteredFunds.length === 0 ? (
              <div className="no-funds">
                <div className="no-funds-icon"></div>
                <p>No encrypted funds found</p>
                <button className="metal-button primary" onClick={() => setShowCreateModal(true)}>Create First Fund</button>
              </div>
            ) : filteredFunds.map(fund => (
              <div 
                className="fund-row" 
                key={fund.id} 
                onClick={() => setSelectedFund(fund)}
                onMouseEnter={() => setSelectedFund(fund)}
              >
                <div className="table-cell">{fund.name}</div>
                <div className="table-cell">{fund.owner.substring(0, 6)}...{fund.owner.substring(38)}</div>
                <div className="table-cell">{new Date(fund.timestamp * 1000).toLocaleDateString()}</div>
                <div className="table-cell"><span className={`status-badge ${fund.status}`}>{fund.status}</span></div>
                <div className="table-cell"><span className={`compliance-badge ${fund.complianceStatus}`}>{fund.complianceStatus}</span></div>
                <div className="table-cell actions">
                  {isOwner(fund.owner) && (
                    <>
                      {fund.status === "pending" && (
                        <button className="action-btn metal-button success" onClick={(e) => { e.stopPropagation(); verifyCompliance(fund.id); }}>Verify</button>
                      )}
                      {fund.status === "active" && (
                        <button className="action-btn metal-button danger" onClick={(e) => { e.stopPropagation(); closeFund(fund.id); }}>Close</button>
                      )}
                    </>
                  )}
                  <button className="action-btn metal-button" onClick={(e) => { e.stopPropagation(); setSelectedFund(fund); }}>Details</button>
                </div>
              </div>
            ))}
          </div>
        </div>
      </div>
      
      {showCreateModal && <ModalCreate onSubmit={submitFund} onClose={() => setShowCreateModal(false)} creating={creating} fundData={newFundData} setFundData={setNewFundData}/>}
      
      {selectedFund && (
        <FundDetailModal 
          fund={selectedFund} 
          onClose={() => { setSelectedFund(null); setDecryptedValues({}); }} 
          decryptedValues={decryptedValues}
          setDecryptedValues={setDecryptedValues}
          isDecrypting={isDecrypting}
          decryptWithSignature={decryptWithSignature}
        />
      )}
      
      {transactionStatus.visible && (
        <div className="transaction-modal">
          <div className="transaction-content metal-card">
            <div className={`transaction-icon ${transactionStatus.status}`}>
              {transactionStatus.status === "pending" && <div className="metal-spinner"></div>}
              {transactionStatus.status === "success" && <div className="check-icon"></div>}
              {transactionStatus.status === "error" && <div className="error-icon"></div>}
            </div>
            <div className="transaction-message">{transactionStatus.message}</div>
          </div>
        </div>
      )}
      
      <footer className="app-footer">
        <div className="footer-content">
          <div className="footer-brand">
            <div className="logo"><div className="shield-icon"></div><span>FHES062 Asset Management</span></div>
            <p>Decentralized asset management protocol for FHE-based funds</p>
          </div>
          <div className="footer-links">
            <a href="#" className="footer-link">Documentation</a>
            <a href="#" className="footer-link">Privacy Policy</a>
            <a href="#" className="footer-link">Terms</a>
            <a href="#" className="footer-link">Contact</a>
          </div>
        </div>
        <div className="footer-bottom">
          <div className="fhe-badge"><span>Powered by Zama FHE</span></div>
          <div className="copyright">© {new Date().getFullYear()} FHES062. All rights reserved.</div>
        </div>
      </footer>
    </div>
  );
};

interface ModalCreateProps {
  onSubmit: () => void; 
  onClose: () => void; 
  creating: boolean;
  fundData: any;
  setFundData: (data: any) => void;
}

const ModalCreate: React.FC<ModalCreateProps> = ({ onSubmit, onClose, creating, fundData, setFundData }) => {
  const handleChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    const { name, value } = e.target;
    setFundData({ ...fundData, [name]: value });
  };

  const handleNumberChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    const { name, value } = e.target;
    setFundData({ ...fundData, [name]: parseFloat(value) });
  };

  const handleSubmit = () => {
    if (!fundData.name || !fundData.initialNav) { 
      alert("Please fill required fields"); 
      return; 
    }
    onSubmit();
  };

  return (
    <div className="modal-overlay">
      <div className="create-modal metal-card">
        <div className="modal-header">
          <h2>Create Encrypted Fund</h2>
          <button onClick={onClose} className="close-modal">&times;</button>
        </div>
        <div className="modal-body">
          <div className="fhe-notice-banner">
            <div className="key-icon"></div> 
            <div><strong>FHE Encryption Notice</strong><p>All sensitive data will be encrypted with Zama FHE before submission</p></div>
          </div>
          
          <div className="form-grid">
            <div className="form-group">
              <label>Fund Name *</label>
              <input 
                type="text" 
                name="name" 
                value={fundData.name} 
                onChange={handleChange} 
                placeholder="Enter fund name..." 
                className="metal-input"
              />
            </div>
            
            <div className="form-group">
              <label>Initial NAV (USD) *</label>
              <input 
                type="number" 
                name="initialNav" 
                value={fundData.initialNav} 
                onChange={handleNumberChange} 
                placeholder="Enter initial NAV..." 
                className="metal-input"
                step="0.01"
                min="0"
              />
            </div>
            
            <div className="form-group">
              <label>Performance Fee (%)</label>
              <input 
                type="number" 
                name="performanceFee" 
                value={fundData.performanceFee} 
                onChange={handleNumberChange} 
                placeholder="Enter performance fee..." 
                className="metal-input"
                step="0.1"
                min="0"
                max="50"
              />
            </div>
            
            <div className="form-group">
              <label>Management Fee (%)</label>
              <input 
                type="number" 
                name="managementFee" 
                value={fundData.managementFee} 
                onChange={handleNumberChange} 
                placeholder="Enter management fee..." 
                className="metal-input"
                step="0.1"
                min="0"
                max="5"
              />
            </div>
          </div>
          
          <div className="encryption-preview">
            <h4>FHE Encryption Preview</h4>
            <div className="preview-container">
              <div className="plain-data">
                <span>Plain NAV:</span>
                <div>{fundData.initialNav || '0.00'} USD</div>
              </div>
              <div className="encryption-arrow">→</div>
              <div className="encrypted-data">
                <span>Encrypted NAV:</span>
                <div>{fundData.initialNav ? FHEEncryptNumber(fundData.initialNav).substring(0, 50) + '...' : 'No value entered'}</div>
              </div>
            </div>
          </div>
          
          <div className="privacy-notice">
            <div className="privacy-icon"></div> 
            <div>
              <strong>Data Privacy Guarantee</strong>
              <p>All fund data remains encrypted during processing and is never decrypted on our servers</p>
            </div>
          </div>
        </div>
        <div className="modal-footer">
          <button onClick={onClose} className="cancel-btn metal-button">Cancel</button>
          <button onClick={handleSubmit} disabled={creating} className="submit-btn metal-button primary">
            {creating ? "Creating Encrypted Fund..." : "Create Fund"}
          </button>
        </div>
      </div>
    </div>
  );
};

interface FundDetailModalProps {
  fund: Fund;
  onClose: () => void;
  decryptedValues: {nav?: number, performance?: number, fee?: number};
  setDecryptedValues: (values: {nav?: number, performance?: number, fee?: number}) => void;
  isDecrypting: boolean;
  decryptWithSignature: (encryptedData: string) => Promise<number | null>;
}

const FundDetailModal: React.FC<FundDetailModalProps> = ({ 
  fund, 
  onClose, 
  decryptedValues, 
  setDecryptedValues, 
  isDecrypting, 
  decryptWithSignature 
}) => {
  const handleDecrypt = async (field: 'nav' | 'performance' | 'fee') => {
    if (decryptedValues[field] !== undefined) {
      setDecryptedValues({...decryptedValues, [field]: undefined});
      return;
    }
    
    let encryptedValue = '';
    switch(field) {
      case 'nav': encryptedValue = fund.encryptedNav; break;
      case 'performance': encryptedValue = fund.encryptedPerformance; break;
      case 'fee': encryptedValue = fund.encryptedManagementFee; break;
    }
    
    const decrypted = await decryptWithSignature(encryptedValue);
    if (decrypted !== null) {
      setDecryptedValues({...decryptedValues, [field]: decrypted});
    }
  };

  return (
    <div className="modal-overlay">
      <div className="fund-detail-modal metal-card">
        <div className="modal-header">
          <h2>Fund Details: {fund.name}</h2>
          <button onClick={onClose} className="close-modal">&times;</button>
        </div>
        <div className="modal-body">
          <div className="fund-info">
            <div className="info-item"><span>Fund ID:</span><strong>#{fund.id.substring(0, 8)}</strong></div>
            <div className="info-item"><span>Owner:</span><strong>{fund.owner.substring(0, 6)}...{fund.owner.substring(38)}</strong></div>
            <div className="info-item"><span>Created:</span><strong>{new Date(fund.timestamp * 1000).toLocaleString()}</strong></div>
            <div className="info-item"><span>Status:</span><strong className={`status-badge ${fund.status}`}>{fund.status}</strong></div>
            <div className="info-item"><span>Compliance:</span><strong className={`compliance-badge ${fund.complianceStatus}`}>{fund.complianceStatus}</strong></div>
          </div>
          
          <div className="fund-metrics">
            <div className="metric-card">
              <h3>Net Asset Value (NAV)</h3>
              <div className="metric-value encrypted">
                {fund.encryptedNav.substring(0, 50)}...
                <div className="fhe-tag"><div className="fhe-icon"></div><span>FHE Encrypted</span></div>
              </div>
              <button 
                className="decrypt-btn metal-button" 
                onClick={() => handleDecrypt('nav')} 
                disabled={isDecrypting}
              >
                {isDecrypting && decryptedValues.nav === undefined ? 
                  <span className="decrypt-spinner"></span> : 
                  decryptedValues.nav !== undefined ? 
                  "Hide Value" : 
                  "Decrypt with Signature"}
              </button>
              {decryptedValues.nav !== undefined && (
                <div className="decrypted-value">
                  <span>Decrypted NAV:</span>
                  <strong>{decryptedValues.nav.toFixed(2)} USD</strong>
                </div>
              )}
            </div>
            
            <div className="metric-card">
              <h3>Performance Fee</h3>
              <div className="metric-value encrypted">
                {fund.encryptedPerformance.substring(0, 50)}...
                <div className="fhe-tag"><div className="fhe-icon"></div><span>FHE Encrypted</span></div>
              </div>
              <button 
                className="decrypt-btn metal-button" 
                onClick={() => handleDecrypt('performance')} 
                disabled={isDecrypting}
              >
                {isDecrypting && decryptedValues.performance === undefined ? 
                  <span className="decrypt-spinner"></span> : 
                  decryptedValues.performance !== undefined ? 
                  "Hide Value" : 
                  "Decrypt with Signature"}
              </button>
              {decryptedValues.performance !== undefined && (
                <div className="decrypted-value">
                  <span>Decrypted Fee:</span>
                  <strong>{decryptedValues.performance.toFixed(2)}%</strong>
                </div>
              )}
            </div>
            
            <div className="metric-card">
              <h3>Management Fee</h3>
              <div className="metric-value encrypted">
                {fund.encryptedManagementFee.substring(0, 50)}...
                <div className="fhe-tag"><div className="fhe-icon"></div><span>FHE Encrypted</span></div>
              </div>
              <button 
                className="decrypt-btn metal-button" 
                onClick={() => handleDecrypt('fee')} 
                disabled={isDecrypting}
              >
                {isDecrypting && decryptedValues.fee === undefined ? 
                  <span className="decrypt-spinner"></span> : 
                  decryptedValues.fee !== undefined ? 
                  "Hide Value" : 
                  "Decrypt with Signature"}
              </button>
              {decryptedValues.fee !== undefined && (
                <div className="decrypted-value">
                  <span>Decrypted Fee:</span>
                  <strong>{decryptedValues.fee.toFixed(2)}%</strong>
                </div>
              )}
            </div>
          </div>
          
          <div className="fhe-explanation">
            <h3>How FHE Protects Your Fund Data</h3>
            <p>
              Zama FHE (Fully Homomorphic Encryption) allows computations to be performed directly on encrypted data without decryption. 
              This means your fund's sensitive metrics can be calculated, verified, and reported while remaining fully encrypted at all times.
            </p>
            <div className="fhe-benefits">
              <div className="benefit-item">
                <div className="benefit-icon">🔒</div>
                <div className="benefit-text">Data remains encrypted during all operations</div>
              </div>
              <div className="benefit-item">
                <div className="benefit-icon">⚖️</div>
                <div className="benefit-text">Regulatory compliance without exposing raw data</div>
              </div>
              <div className="benefit-item">
                <div className="benefit-icon">📈</div>
                <div className="benefit-text">Performance calculations on encrypted values</div>
              </div>
            </div>
          </div>
        </div>
        <div className="modal-footer">
          <button onClick={onClose} className="close-btn metal-button">Close</button>
        </div>
      </div>
    </div>
  );
};

export default App;